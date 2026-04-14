import type { Bindings, ForumSnapshot, PublicPostItem, Role } from './types';
import { ApiError, createId, escapeForLike, gravatarHashFromEmail, makePreview, normalizeUsername, unixNow } from './core';

export async function assertUniqueCredentials(
  env: Bindings,
  username: string | null,
  email: string | null,
  excludeUserId?: string,
): Promise<void> {
  if (username) {
    const row = await env.DB.prepare(
      `SELECT id FROM users
       WHERE username_lower = ?
         AND (? IS NULL OR id != ?)
       LIMIT 1`,
    ).bind(normalizeUsername(username), excludeUserId ?? null, excludeUserId ?? null).first();
    if (row) {
      throw new ApiError(409, '用户名已被使用');
    }
  }
  if (email) {
    const row = await env.DB.prepare(
      `SELECT id FROM users
       WHERE lower(email) = ?
         AND (? IS NULL OR id != ?)
       LIMIT 1`,
    ).bind(email.toLowerCase(), excludeUserId ?? null, excludeUserId ?? null).first();
    if (row) {
      throw new ApiError(409, '邮箱已被使用');
    }
  }
}

export async function listPublicPosts(
  env: Bindings,
  options: { page: number; pageSize: number; boardId: string; q: string },
): Promise<{
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: PublicPostItem[];
}> {
  const offset = (options.page - 1) * options.pageSize;
  const filters = ['posts.is_deleted = 0', "users.status != 'deleted'", 'boards.is_visible = 1'];
  const binds: Array<string | number> = [];
  if (options.boardId) {
    filters.push('posts.board_id = ?');
    binds.push(options.boardId);
  }
  if (options.q) {
    const like = `%${escapeForLike(options.q.toLowerCase())}%`;
    filters.push("(lower(posts.title) LIKE ? ESCAPE '\\' OR lower(posts.content_md) LIKE ? ESCAPE '\\' OR users.username_lower LIKE ? ESCAPE '\\')");
    binds.push(like, like, like);
  }
  const where = filters.join(' AND ');
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM posts
     JOIN boards ON boards.id = posts.board_id
     JOIN users ON users.id = posts.author_id
     WHERE ${where}`,
  ).bind(...binds).first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const { results } = await env.DB.prepare(
    `SELECT posts.id, posts.board_id, posts.title, posts.content_md, posts.reply_count, posts.like_count, posts.view_count,
            posts.is_pinned, posts.created_at, posts.last_activity_at,
            boards.slug AS board_slug, boards.name AS board_name, boards.icon AS board_icon, boards.accent AS board_accent,
            users.id AS author_id, users.username AS author_name, users.role AS author_role, users.email AS author_email
     FROM posts
     JOIN boards ON boards.id = posts.board_id
     JOIN users ON users.id = posts.author_id
     WHERE ${where}
     ORDER BY posts.is_pinned DESC, posts.last_activity_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(...binds, options.pageSize, offset).all<{
    id: string;
    board_id: string;
    title: string;
    content_md: string;
    reply_count: number;
    like_count: number;
    view_count: number;
    is_pinned: number;
    created_at: number;
    last_activity_at: number;
    board_slug: string;
    board_name: string;
    board_icon: string;
    board_accent: string;
    author_id: string;
    author_name: string;
    author_role: Role;
    author_email: string;
  }>();
  return {
    page: options.page,
    pageSize: options.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / options.pageSize)),
    items: results.map((row) => ({
      id: row.id,
      boardId: row.board_id,
      boardSlug: row.board_slug,
      boardName: row.board_name,
      boardIcon: row.board_icon,
      boardAccent: row.board_accent,
      isPinned: Boolean(row.is_pinned),
      title: row.title,
      contentPreview: makePreview(row.content_md),
      replyCount: row.reply_count,
      likeCount: row.like_count,
      viewCount: row.view_count,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      author: {
        id: row.author_id,
        name: row.author_name,
        role: row.author_role,
        avatarHash: gravatarHashFromEmail(row.author_email),
      },
    })),
  };
}

export async function getPostDetail(env: Bindings, postId: string): Promise<{
  id: string;
  boardId: string;
  boardSlug: string;
  boardName: string;
  boardIcon: string;
  boardAccent: string;
  isPinned: boolean;
  title: string;
  content: string;
  replyCount: number;
  likeCount: number;
  viewCount: number;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  author: {
    id: string;
    name: string;
    role: Role;
    avatarHash: string;
  };
} | null> {
  const row = await env.DB.prepare(
    `SELECT posts.id, posts.board_id, posts.title, posts.content_md, posts.reply_count, posts.like_count, posts.view_count,
            posts.is_pinned, posts.created_at, posts.updated_at, posts.last_activity_at,
            boards.slug AS board_slug, boards.name AS board_name, boards.icon AS board_icon, boards.accent AS board_accent,
            users.id AS author_id, users.username AS author_name, users.role AS author_role, users.email AS author_email
     FROM posts
     JOIN boards ON boards.id = posts.board_id
     JOIN users ON users.id = posts.author_id
     WHERE posts.id = ? AND posts.is_deleted = 0 AND users.status != 'deleted'
     LIMIT 1`,
  ).bind(postId).first<{
    id: string;
    board_id: string;
    title: string;
    content_md: string;
    reply_count: number;
    like_count: number;
    view_count: number;
    is_pinned: number;
    created_at: number;
    updated_at: number;
    last_activity_at: number;
    board_slug: string;
    board_name: string;
    board_icon: string;
    board_accent: string;
    author_id: string;
    author_name: string;
    author_role: Role;
    author_email: string;
  }>();
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    boardId: row.board_id,
    boardSlug: row.board_slug,
    boardName: row.board_name,
    boardIcon: row.board_icon,
    boardAccent: row.board_accent,
    isPinned: Boolean(row.is_pinned),
    title: row.title,
    content: row.content_md,
    replyCount: row.reply_count,
    likeCount: row.like_count,
    viewCount: row.view_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    author: {
      id: row.author_id,
      name: row.author_name,
      role: row.author_role,
      avatarHash: gravatarHashFromEmail(row.author_email),
    },
  };
}

export async function listReplies(
  env: Bindings,
  postId: string,
  page: number,
  pageSize: number,
): Promise<{
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: Array<{
    id: string;
    content: string;
    likeCount: number;
    createdAt: number;
    updatedAt: number;
    author: {
      id: string;
      name: string;
      role: Role;
      avatarHash: string;
    };
  }>;
}> {
  const offset = (page - 1) * pageSize;
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM replies
     JOIN users ON users.id = replies.author_id
     WHERE replies.post_id = ? AND replies.is_deleted = 0 AND users.status != 'deleted'`,
  ).bind(postId).first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const { results } = await env.DB.prepare(
    `SELECT replies.id, replies.content_md, replies.like_count, replies.created_at, replies.updated_at,
            users.id AS author_id, users.username AS author_name, users.role AS author_role, users.email AS author_email
     FROM replies
     JOIN users ON users.id = replies.author_id
     WHERE replies.post_id = ? AND replies.is_deleted = 0 AND users.status != 'deleted'
     ORDER BY replies.created_at ASC
     LIMIT ? OFFSET ?`,
  ).bind(postId, pageSize, offset).all<{
    id: string;
    content_md: string;
    like_count: number;
    created_at: number;
    updated_at: number;
    author_id: string;
    author_name: string;
    author_role: Role;
    author_email: string;
  }>();
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items: results.map((row) => ({
      id: row.id,
      content: row.content_md,
      likeCount: row.like_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      author: {
        id: row.author_id,
        name: row.author_name,
        role: row.author_role,
        avatarHash: gravatarHashFromEmail(row.author_email),
      },
    })),
  };
}

export async function searchPosts(env: Bindings, q: string) {
  const like = `%${escapeForLike(q.toLowerCase())}%`;
  const { results } = await env.DB.prepare(
    `SELECT posts.id, posts.title, posts.content_md, boards.name AS board_name, users.username AS author_name,
            posts.last_activity_at
     FROM posts
     JOIN boards ON boards.id = posts.board_id
     JOIN users ON users.id = posts.author_id
     WHERE posts.is_deleted = 0
       AND users.status != 'deleted'
       AND (lower(posts.title) LIKE ? ESCAPE '\\'
         OR lower(posts.content_md) LIKE ? ESCAPE '\\'
         OR users.username_lower LIKE ? ESCAPE '\\')
     ORDER BY posts.last_activity_at DESC
     LIMIT 20`,
  ).bind(like, like, like).all<{
    id: string;
    title: string;
    content_md: string;
    board_name: string;
    author_name: string;
    last_activity_at: number;
  }>();
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    preview: makePreview(row.content_md),
    boardName: row.board_name,
    authorName: row.author_name,
    lastActivityAt: row.last_activity_at,
  }));
}

export async function searchUsers(env: Bindings, q: string) {
  const like = `%${escapeForLike(q.toLowerCase())}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, username, role, bio, created_at
     FROM users
     WHERE status = 'active'
       AND (username_lower LIKE ? ESCAPE '\\' OR lower(bio) LIKE ? ESCAPE '\\')
     ORDER BY role = 'admin' DESC, created_at DESC
     LIMIT 12`,
  ).bind(like, like).all<{
    id: string;
    username: string;
    role: Role;
    bio: string;
    created_at: number;
  }>();
  return results.map((row) => ({
    id: row.id,
    username: row.username,
    role: row.role,
    bio: row.bio,
    createdAt: row.created_at,
  }));
}

export async function addLike(
  env: Bindings,
  userId: string,
  targetType: 'post' | 'reply',
  targetId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO likes (user_id, target_type, target_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(userId, targetType, targetId, unixNow()).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function isTargetLiked(
  env: Bindings,
  userId: string,
  targetType: 'post' | 'reply',
  targetId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS liked FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
  ).bind(userId, targetType, targetId).first<{ liked: number }>();
  return Boolean(row?.liked);
}

export async function getLikedTargetIds(
  env: Bindings,
  userId: string,
  targetType: 'post' | 'reply',
  targetIds: string[],
): Promise<string[]> {
  if (!targetIds.length) {
    return [];
  }
  const placeholders = targetIds.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT target_id
     FROM likes
     WHERE user_id = ? AND target_type = ? AND target_id IN (${placeholders})`,
  ).bind(userId, targetType, ...targetIds).all<{ target_id: string }>();
  return results.map((row) => row.target_id);
}

export async function createNotification(
  env: Bindings,
  input: {
    userId: string;
    actorId: string;
    actorName: string;
    type: string;
    postId: string | null;
    replyId: string | null;
    textPreview: string;
  },
): Promise<void> {
  if (input.userId === input.actorId) {
    return;
  }
  await env.DB.prepare(
    `INSERT INTO notifications
    (id, user_id, actor_id, actor_name, type, post_id, reply_id, text_preview, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).bind(
    createId('ntf'),
    input.userId,
    input.actorId,
    input.actorName,
    input.type,
    input.postId,
    input.replyId,
    input.textPreview.slice(0, 160),
    unixNow(),
  ).run();
}

export async function getUnreadNotificationCount(env: Bindings, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0',
  ).bind(userId).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function assertNotLastAdmin(env: Bindings, userId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status != 'deleted' AND id != ?",
  ).bind(userId).first<{ total: number }>();
  if (Number(row?.total ?? 0) === 0) {
    throw new ApiError(409, '至少需要保留一个管理员');
  }
}

export async function softDeletePosts(env: Bindings, postIds: string[]): Promise<number> {
  const ids = uniqueIds(postIds);
  if (!ids.length) {
    return 0;
  }
  const placeholders = ids.map(() => '?').join(', ');
  const now = unixNow();
  const result = await env.DB.prepare(
    `UPDATE posts
     SET is_deleted = 1, deleted_at = ?, updated_at = ?
     WHERE is_deleted = 0 AND id IN (${placeholders})`,
  ).bind(now, now, ...ids).run();
  return Number(result.meta.changes ?? 0);
}

export async function restorePosts(env: Bindings, postIds: string[]): Promise<number> {
  const ids = uniqueIds(postIds);
  if (!ids.length) {
    return 0;
  }
  const placeholders = ids.map(() => '?').join(', ');
  const now = unixNow();
  const result = await env.DB.prepare(
    `UPDATE posts
     SET is_deleted = 0, deleted_at = NULL, updated_at = ?
     WHERE is_deleted = 1 AND id IN (${placeholders})`,
  ).bind(now, ...ids).run();
  await recalculatePostStats(env, ids);
  return Number(result.meta.changes ?? 0);
}

export async function purgePosts(env: Bindings, postIds: string[]): Promise<void> {
  for (const postId of uniqueIds(postIds)) {
    await deletePostCascade(env, postId);
  }
}

export async function softDeleteUsers(env: Bindings, userIds: string[]): Promise<number> {
  const ids = uniqueIds(userIds);
  if (!ids.length) {
    return 0;
  }
  const placeholders = ids.map(() => '?').join(', ');
  const now = unixNow();
  const result = await env.DB.prepare(
    `UPDATE users
     SET status_before_delete = CASE WHEN status = 'deleted' THEN status_before_delete ELSE status END,
         status = 'deleted',
         deleted_at = ?,
         updated_at = ?
     WHERE status != 'deleted' AND id IN (${placeholders})`,
  ).bind(now, now, ...ids).run();
  await recalculatePostsForUsers(env, ids);
  return Number(result.meta.changes ?? 0);
}

export async function restoreUsers(env: Bindings, userIds: string[]): Promise<number> {
  const ids = uniqueIds(userIds);
  if (!ids.length) {
    return 0;
  }
  const placeholders = ids.map(() => '?').join(', ');
  const now = unixNow();
  const result = await env.DB.prepare(
    `UPDATE users
     SET status = COALESCE(status_before_delete, 'active'),
         status_before_delete = NULL,
         deleted_at = NULL,
         updated_at = ?
     WHERE status = 'deleted' AND id IN (${placeholders})`,
  ).bind(now, ...ids).run();
  await recalculatePostsForUsers(env, ids);
  return Number(result.meta.changes ?? 0);
}

export async function purgeUsers(env: Bindings, userIds: string[]): Promise<void> {
  for (const userId of uniqueIds(userIds)) {
    await deleteUserCascade(env, userId);
  }
}

export async function deletePostCascade(env: Bindings, postId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    'SELECT id FROM replies WHERE post_id = ?',
  ).bind(postId).all<{ id: string }>();
  const replyIds = results.map((row) => row.id);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM likes WHERE target_type = 'post' AND target_id = ?").bind(postId),
    env.DB.prepare('DELETE FROM notifications WHERE post_id = ?').bind(postId),
  ];
  for (const replyId of replyIds) {
    statements.push(
      env.DB.prepare("DELETE FROM likes WHERE target_type = 'reply' AND target_id = ?").bind(replyId),
      env.DB.prepare('DELETE FROM notifications WHERE reply_id = ?').bind(replyId),
    );
  }
  statements.push(env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId));
  await env.DB.batch(statements);
}

export async function deleteUserCascade(env: Bindings, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM likes WHERE target_type = 'post' AND target_id IN (SELECT id FROM posts WHERE author_id = ?)").bind(userId),
    env.DB.prepare("DELETE FROM likes WHERE target_type = 'reply' AND target_id IN (SELECT id FROM replies WHERE author_id = ? OR post_id IN (SELECT id FROM posts WHERE author_id = ?))").bind(userId, userId),
    env.DB.prepare('DELETE FROM likes WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM notifications WHERE user_id = ? OR actor_id = ?').bind(userId, userId),
    env.DB.prepare('DELETE FROM notifications WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)').bind(userId),
    env.DB.prepare('DELETE FROM notifications WHERE reply_id IN (SELECT id FROM replies WHERE author_id = ? OR post_id IN (SELECT id FROM posts WHERE author_id = ?))').bind(userId, userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

async function recalculatePostsForUsers(env: Bindings, userIds: string[]): Promise<void> {
  const ids = uniqueIds(userIds);
  if (!ids.length) {
    return;
  }
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT post_id
     FROM (
       SELECT replies.post_id AS post_id
       FROM replies
       WHERE replies.author_id IN (${placeholders})
       UNION
       SELECT posts.id AS post_id
       FROM posts
       WHERE posts.author_id IN (${placeholders})
     )`,
  ).bind(...ids, ...ids).all<{ post_id: string }>();
  await recalculatePostStats(env, results.map((row) => row.post_id));
}

async function recalculatePostStats(env: Bindings, postIds: string[]): Promise<void> {
  const ids = uniqueIds(postIds);
  if (!ids.length) {
    return;
  }
  const now = unixNow();
  const statements = ids.map((postId) =>
    env.DB.prepare(
      `UPDATE posts
       SET reply_count = (
             SELECT COUNT(*)
             FROM replies
             JOIN users ON users.id = replies.author_id
             WHERE replies.post_id = posts.id
               AND replies.is_deleted = 0
               AND users.status != 'deleted'
           ),
           last_activity_at = COALESCE(
             (
               SELECT MAX(replies.created_at)
               FROM replies
               JOIN users ON users.id = replies.author_id
               WHERE replies.post_id = posts.id
                 AND replies.is_deleted = 0
                 AND users.status != 'deleted'
             ),
             posts.created_at
           ),
           updated_at = ?
       WHERE id = ?`,
    ).bind(now, postId),
  );
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export async function exportForumData(env: Bindings): Promise<ForumSnapshot> {
  const [settings, boards, users, posts, replies, likes, notifications] = await Promise.all([
    env.DB.prepare('SELECT * FROM settings').all(),
    env.DB.prepare('SELECT * FROM boards').all(),
    env.DB.prepare('SELECT * FROM users').all(),
    env.DB.prepare('SELECT * FROM posts').all(),
    env.DB.prepare('SELECT * FROM replies').all(),
    env.DB.prepare('SELECT * FROM likes').all(),
    env.DB.prepare('SELECT * FROM notifications').all(),
  ]);
  return {
    version: 1,
    createdAt: unixNow(),
    tables: {
      settings: settings.results as Array<Record<string, unknown>>,
      boards: boards.results as Array<Record<string, unknown>>,
      users: users.results as Array<Record<string, unknown>>,
      posts: posts.results as Array<Record<string, unknown>>,
      replies: replies.results as Array<Record<string, unknown>>,
      likes: likes.results as Array<Record<string, unknown>>,
      notifications: notifications.results as Array<Record<string, unknown>>,
    },
  };
}

export async function restoreForumData(env: Bindings, snapshot: ForumSnapshot): Promise<void> {
  const deletes = [
    'DELETE FROM likes',
    'DELETE FROM notifications',
    'DELETE FROM replies',
    'DELETE FROM posts',
    'DELETE FROM users',
    'DELETE FROM boards',
    'DELETE FROM settings',
  ];
  for (const sql of deletes) {
    await env.DB.prepare(sql).run();
  }
  await insertRows(env, 'settings', ['key', 'value', 'updated_at'], snapshot.tables.settings);
  await insertRows(env, 'boards', ['id', 'slug', 'name', 'icon', 'description', 'accent', 'sort_order', 'is_visible', 'created_at', 'updated_at'], snapshot.tables.boards);
  await insertRows(env, 'users', ['id', 'username', 'username_lower', 'email', 'password_hash', 'role', 'status', 'bio', 'created_at', 'updated_at', 'last_login_at', 'deleted_at', 'status_before_delete'], snapshot.tables.users);
  await insertRows(env, 'posts', ['id', 'board_id', 'author_id', 'title', 'content_md', 'like_count', 'reply_count', 'view_count', 'is_pinned', 'is_deleted', 'created_at', 'updated_at', 'last_activity_at', 'deleted_at'], snapshot.tables.posts);
  await insertRows(env, 'replies', ['id', 'post_id', 'author_id', 'content_md', 'like_count', 'is_deleted', 'created_at', 'updated_at', 'deleted_at'], snapshot.tables.replies);
  await insertRows(env, 'likes', ['user_id', 'target_type', 'target_id', 'created_at'], snapshot.tables.likes);
  await insertRows(env, 'notifications', ['id', 'user_id', 'actor_id', 'actor_name', 'type', 'post_id', 'reply_id', 'text_preview', 'is_read', 'created_at'], snapshot.tables.notifications);
}

async function insertRows(
  env: Bindings,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (!rows.length) {
    return;
  }
  const placeholders = columns.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  const statements = rows.map((row) =>
    env.DB.prepare(sql).bind(...columns.map((column) => normalizeDbValue(row[column]))),
  );
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
}

function normalizeDbValue(value: unknown): string | number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return JSON.stringify(value);
}
