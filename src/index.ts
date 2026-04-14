import { Hono } from 'hono';
import type { ZodError } from 'zod';
import {
  adminProfileSchema,
  backupSchema,
  boardSchema,
  createPostSchema,
  createReplySchema,
  idBatchSchema,
  loginSchema,
  markNotificationsSchema,
  pinPostSchema,
  registerSchema,
  emailSchema,
  settingsSchema,
  setupSchema,
  updateUserSchema,
  userEmailSchema,
  userPasswordSchema,
  type AppEnv,
  type AppUser,
  type ForumSnapshot,
  type Role,
} from './lib/types';
import {
  ApiError,
  applyRateLimit,
  bumpCacheBuckets,
  cleanQuery,
  clearSession,
  createId,
  createSession,
  forumHasAdmin,
  getAdminCapabilities,
  hashPassword,
  isLegacyPasswordHash,
  loadAdminSettings,
  loadBoards,
  loadSettings,
  parsePage,
  publicUser,
  readJson,
  readThroughCache,
  requireAdmin,
  requireAdminAccess,
  requireAdminCapability,
  requireUser,
  resolveSessionUser,
  safeJsonParse,
  unixNow,
  verifyTurnstile,
  verifyPassword,
} from './lib/core';
import {
  addLike,
  assertNotLastAdmin,
  assertUniqueCredentials,
  createNotification,
  deletePostCascade,
  deleteUserCascade,
  exportForumData,
  getLikedTargetIds,
  getPostDetail,
  getUnreadNotificationCount,
  isTargetLiked,
  listPublicPosts,
  listReplies,
  purgePosts,
  purgeUsers,
  restorePosts,
  restoreUsers,
  restoreForumData,
  searchPosts,
  searchUsers,
  softDeletePosts,
  softDeleteUsers,
} from './lib/data';

const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  const token = c.req.header('cookie')?.match(/(?:^|;\s*)bbs_session=([^;]+)/)?.[1] ?? null;
  c.set('sessionToken', token);
  c.set('user', await resolveSessionUser(c, token));
  await next();
});

app.get('/api/health', (c) => c.json({ ok: true, now: unixNow() }));

app.get('/api/public/bootstrap', async (c) => {
  const [settings, boards, hasAdmin] = await Promise.all([
    loadSettings(c.env),
    loadBoards(c.env),
    forumHasAdmin(c.env),
  ]);
  const user = c.get('user');
  const unread = user ? await getUserNotificationUnreadCount(c.env, user.id) : 0;
  return c.json({
    forum: settings,
    boards,
    hasAdmin,
    needsSetup: !hasAdmin,
    currentUser: user ? publicUser(user) : null,
    unreadNotifications: unread,
  });
});

app.get('/api/public/posts', async (c) => {
  const settings = await loadSettings(c.env);
  const page = parsePage(c.req.query('page'));
  const boardKey = (c.req.query('board') ?? '').trim();
  const boardId = await resolvePublicBoardId(c.env, boardKey);
  const q = cleanQuery(c.req.query('q'));
  const pageSize = settings.pageSizePosts;
  const data = await readThroughCache(
    c.env,
    'posts',
    `list:${boardKey || 'all'}:${q || 'none'}:${page}:${pageSize}`,
    20,
    async () => listPublicPosts(c.env, { page, pageSize, boardId, q }),
  );
  const user = c.get('user');
  const likedIds = user && data.items.length
    ? await getLikedTargetIds(c.env, user.id, 'post', data.items.map((item) => item.id))
    : [];
  return c.json({
    ...data,
    items: data.items.map((item) => ({
      ...item,
      liked: likedIds.includes(item.id),
    })),
  });
});

app.get('/api/public/posts/:postId', async (c) => {
  const postId = c.req.param('postId');
  const post = await getPostDetail(c.env, postId);
  if (!post) {
    throw new ApiError(404, '帖子不存在');
  }
  const user = c.get('user');
  const liked = user ? await isTargetLiked(c.env, user.id, 'post', postId) : false;
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').bind(postId).run(),
  );
  return c.json({ post: { ...post, liked } });
});

app.get('/api/public/posts/:postId/replies', async (c) => {
  const settings = await loadSettings(c.env);
  const page = parsePage(c.req.query('page'));
  const data = await listReplies(c.env, c.req.param('postId'), page, settings.pageSizeReplies);
  const user = c.get('user');
  const likedIds = user && data.items.length
    ? await getLikedTargetIds(c.env, user.id, 'reply', data.items.map((item) => item.id))
    : [];
  return c.json({
    ...data,
    items: data.items.map((item) => ({
      ...item,
      liked: likedIds.includes(item.id),
    })),
  });
});

app.get('/api/public/search', async (c) => {
  const q = cleanQuery(c.req.query('q'));
  if (!q) {
    throw new ApiError(400, '请输入搜索关键词');
  }
  const [posts, users] = await Promise.all([searchPosts(c.env, q), searchUsers(c.env, q)]);
  return c.json({ q, posts, users });
});

app.post('/api/setup/admin', async (c) => {
  await applyRateLimit(c, 'setup', 3, 600);
  if (await forumHasAdmin(c.env)) {
    throw new ApiError(409, '论坛已经初始化');
  }
  const body = await readJson(c, setupSchema);
  const now = unixNow();
  const userId = createId('usr');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users
      (id, username, username_lower, email, password_hash, role, status, bio, created_at, updated_at, last_login_at)
      VALUES (?, ?, lower(?), ?, ?, 'admin', 'active', '', ?, ?, ?)`,
    ).bind(userId, body.username, body.username, body.email.toLowerCase(), await hashPassword(body.password), now, now, now),
    ...(body.forumTitle
      ? [
          c.env.DB.prepare(
            `INSERT INTO settings (key, value, updated_at)
             VALUES ('forum_title', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          ).bind(body.forumTitle, now),
        ]
      : []),
    ...(body.forumDescription
      ? [
          c.env.DB.prepare(
            `INSERT INTO settings (key, value, updated_at)
             VALUES ('forum_description', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          ).bind(body.forumDescription, now),
        ]
      : []),
  ]);
  const user: AppUser = {
    id: userId,
    username: body.username,
    email: body.email.toLowerCase(),
    role: 'admin',
    status: 'active',
    bio: '',
    createdAt: now,
  };
  await Promise.all([createSession(c, user), bumpCacheBuckets(c.env, ['meta', 'admin'])]);
  return c.json({ ok: true, user: publicUser(user) }, 201);
});

app.post('/api/auth/register', async (c) => {
  await applyRateLimit(c, 'register', 4, 600);
  if (!(await forumHasAdmin(c.env))) {
    throw new ApiError(409, '论坛尚未初始化');
  }
  const settings = await loadSettings(c.env);
  if (!settings.allowRegistration) {
    throw new ApiError(403, '论坛暂时关闭注册');
  }
  const body = await readJson(c, registerSchema);
  await verifyTurnstile(c, body.turnstileToken, 'register');
  await assertUniqueCredentials(c.env, body.username, body.email);
  const now = unixNow();
  const user: AppUser = {
    id: createId('usr'),
    username: body.username,
    email: body.email.toLowerCase(),
    role: 'member',
    status: 'active',
    bio: '',
    createdAt: now,
  };
  await c.env.DB.prepare(
    `INSERT INTO users
    (id, username, username_lower, email, password_hash, role, status, bio, created_at, updated_at, last_login_at)
    VALUES (?, ?, lower(?), ?, ?, ?, ?, '', ?, ?, ?)`,
  ).bind(user.id, user.username, user.username, user.email, await hashPassword(body.password), user.role, user.status, now, now, now).run();
  await Promise.all([createSession(c, user), bumpCacheBuckets(c.env, ['admin'])]);
  return c.json({ ok: true, user: publicUser(user) }, 201);
});

app.post('/api/auth/login', async (c) => {
  await applyRateLimit(c, 'login', 6, 600);
  const body = await readJson(c, loginSchema);
  const identifier = body.identifier.trim();
  const row = await c.env.DB.prepare(
    `SELECT id, username, email, password_hash, role, status, bio, created_at
     FROM users
     WHERE username_lower = lower(?) OR lower(email) = lower(?)
     LIMIT 1`,
  ).bind(identifier, identifier).first<{
    id: string;
    username: string;
    email: string;
    password_hash: string;
    role: Role;
    status: AppUser['status'];
    bio: string;
    created_at: number;
  }>();
  if (!row || !(await verifyPassword(body.password, row.password_hash))) {
    throw new ApiError(401, '账号或密码错误');
  }
  if (row.status !== 'active') {
    throw new ApiError(403, '账号已被停用');
  }
  const now = unixNow();
  const nextPasswordHash = isLegacyPasswordHash(row.password_hash)
    ? await hashPassword(body.password)
    : null;
  if (nextPasswordHash) {
    await c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, last_login_at = ?, updated_at = ? WHERE id = ?',
    ).bind(nextPasswordHash, now, now, row.id).run();
  } else {
    await c.env.DB.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').bind(now, now, row.id).run();
  }
  const user: AppUser = {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    bio: row.bio,
    createdAt: row.created_at,
  };
  await createSession(c, user);
  return c.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/logout', async (c) => {
  await clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const user = requireUser(c);
  const unread = await getUserNotificationUnreadCount(c.env, user.id);
  return c.json({ user: publicUser(user), unreadNotifications: unread });
});

app.get('/api/profile/email-availability', async (c) => {
  const user = requireUser(c);
  const parsed = emailSchema.safeParse(c.req.query('email') ?? '');
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message ?? '邮箱格式不正确');
  }
  const email = parsed.data.toLowerCase();
  if (email === user.email.toLowerCase()) {
    return c.json({ available: true, sameAsCurrent: true });
  }
  await assertUniqueCredentials(c.env, null, email, user.id);
  return c.json({ available: true, sameAsCurrent: false });
});

app.put('/api/profile/password', async (c) => {
  const user = requireUser(c);
  const body = await readJson(c, userPasswordSchema);
  const dbUser = await c.env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
  ).bind(user.id).first<{ password_hash: string }>();
  if (!dbUser || !(await verifyPassword(body.currentPassword, dbUser.password_hash))) {
    throw new ApiError(401, '当前密码不正确');
  }
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
  ).bind(await hashPassword(body.newPassword), unixNow(), user.id).run();
  await createSession(c, user);
  return c.json({ ok: true });
});

app.put('/api/profile/email', async (c) => {
  const user = requireUser(c);
  const body = await readJson(c, userEmailSchema);
  const nextEmail = body.email.toLowerCase();
  if (nextEmail === user.email.toLowerCase()) {
    throw new ApiError(409, '当前使用的就是这个邮箱');
  }
  const dbUser = await c.env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
  ).bind(user.id).first<{ password_hash: string }>();
  if (!dbUser || !(await verifyPassword(body.currentPassword, dbUser.password_hash))) {
    throw new ApiError(401, '当前密码不正确');
  }
  await assertUniqueCredentials(c.env, null, nextEmail, user.id);
  await c.env.DB.prepare(
    'UPDATE users SET email = ?, updated_at = ? WHERE id = ?',
  ).bind(nextEmail, unixNow(), user.id).run();
  const nextUser: AppUser = {
    ...user,
    email: nextEmail,
  };
  c.set('user', nextUser);
  await Promise.all([
    createSession(c, nextUser),
    bumpCacheBuckets(c.env, ['posts', 'admin']),
  ]);
  return c.json({ ok: true, user: publicUser(nextUser) });
});

app.post('/api/posts', async (c) => {
  const user = requireUser(c);
  await applyRateLimit(c, 'post', 8, 600);
  const body = await readJson(c, createPostSchema);
  const board = await c.env.DB.prepare('SELECT id, is_visible FROM boards WHERE id = ? LIMIT 1').bind(body.boardId).first<{ id: string; is_visible: number }>();
  if (!board || !board.is_visible) {
    throw new ApiError(404, '板块不存在');
  }
  await verifyTurnstile(c, body.turnstileToken, 'post');
  const now = unixNow();
  const postId = createId('pst');
  await c.env.DB.prepare(
    `INSERT INTO posts
    (id, board_id, author_id, title, content_md, like_count, reply_count, view_count, is_pinned, is_deleted, created_at, updated_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?)`,
  ).bind(postId, body.boardId, user.id, body.title, body.content, now, now, now).run();
  await bumpCacheBuckets(c.env, ['posts', 'admin']);
  return c.json({ ok: true, id: postId }, 201);
});

app.post('/api/posts/:postId/replies', async (c) => {
  const user = requireUser(c);
  await applyRateLimit(c, 'reply', 20, 300);
  const postId = c.req.param('postId');
  const body = await readJson(c, createReplySchema);
  const post = await c.env.DB.prepare(
    `SELECT posts.id, posts.title, posts.author_id
     FROM posts
     JOIN users ON users.id = posts.author_id
     WHERE posts.id = ? AND posts.is_deleted = 0 AND users.status != 'deleted'
     LIMIT 1`,
  ).bind(postId).first<{ id: string; title: string; author_id: string }>();
  if (!post) {
    throw new ApiError(404, '帖子不存在');
  }
  await verifyTurnstile(c, body.turnstileToken, 'reply');
  const now = unixNow();
  const replyId = createId('rpl');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO replies
      (id, post_id, author_id, content_md, like_count, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    ).bind(replyId, postId, user.id, body.content, now, now),
    c.env.DB.prepare(
      'UPDATE posts SET reply_count = reply_count + 1, updated_at = ?, last_activity_at = ? WHERE id = ?',
    ).bind(now, now, postId),
  ]);
  await createNotification(c.env, {
    userId: post.author_id,
    actorId: user.id,
    actorName: user.username,
    type: 'reply',
    postId,
    replyId,
    textPreview: `${post.title} · ${body.content}`,
  });
  await bumpCacheBuckets(c.env, ['posts', 'notifications', 'admin']);
  return c.json({ ok: true, id: replyId }, 201);
});

app.post('/api/posts/:postId/like', async (c) => {
  const user = requireUser(c);
  await applyRateLimit(c, 'like-post', 50, 300);
  const postId = c.req.param('postId');
  const post = await c.env.DB.prepare(
    `SELECT posts.id, posts.author_id, posts.title
     FROM posts
     JOIN users ON users.id = posts.author_id
     WHERE posts.id = ? AND posts.is_deleted = 0 AND users.status != 'deleted'
     LIMIT 1`,
  ).bind(postId).first<{ id: string; author_id: string; title: string }>();
  if (!post) {
    throw new ApiError(404, '帖子不存在');
  }
  const inserted = await addLike(c.env, user.id, 'post', postId);
  if (inserted) {
    await c.env.DB.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').bind(postId).run();
    await createNotification(c.env, {
      userId: post.author_id,
      actorId: user.id,
      actorName: user.username,
      type: 'post_like',
      postId,
      replyId: null,
      textPreview: post.title,
    });
    await bumpCacheBuckets(c.env, ['posts', 'notifications']);
  }
  const updated = await c.env.DB.prepare('SELECT like_count FROM posts WHERE id = ?').bind(postId).first<{ like_count: number }>();
  return c.json({ ok: true, liked: true, alreadyLiked: !inserted, count: Number(updated?.like_count ?? 0) });
});

app.post('/api/replies/:replyId/like', async (c) => {
  const user = requireUser(c);
  await applyRateLimit(c, 'like-reply', 50, 300);
  const replyId = c.req.param('replyId');
  const reply = await c.env.DB.prepare(
    `SELECT replies.id, replies.author_id, replies.content_md, replies.post_id, posts.title
     FROM replies
     JOIN posts ON posts.id = replies.post_id
     JOIN users ON users.id = replies.author_id
     WHERE replies.id = ? AND replies.is_deleted = 0 AND users.status != 'deleted' AND posts.is_deleted = 0
     LIMIT 1`,
  ).bind(replyId).first<{ id: string; author_id: string; content_md: string; post_id: string; title: string }>();
  if (!reply) {
    throw new ApiError(404, '回复不存在');
  }
  const inserted = await addLike(c.env, user.id, 'reply', replyId);
  if (inserted) {
    await c.env.DB.prepare('UPDATE replies SET like_count = like_count + 1 WHERE id = ?').bind(replyId).run();
    await createNotification(c.env, {
      userId: reply.author_id,
      actorId: user.id,
      actorName: user.username,
      type: 'reply_like',
      postId: reply.post_id,
      replyId,
      textPreview: `${reply.title} · ${reply.content_md}`,
    });
    await bumpCacheBuckets(c.env, ['posts', 'notifications']);
  }
  const updated = await c.env.DB.prepare('SELECT like_count FROM replies WHERE id = ?').bind(replyId).first<{ like_count: number }>();
  return c.json({ ok: true, liked: true, alreadyLiked: !inserted, count: Number(updated?.like_count ?? 0) });
});

app.get('/api/notifications', async (c) => {
  const user = requireUser(c);
  const page = parsePage(c.req.query('page'));
  const pageSize = 20;
  const totalRow = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?').bind(user.id).first<{ total: number }>();
  const dbTotal = Number(totalRow?.total ?? 0);
  const systemNotice = await getSystemNoticeNotification(c.env, user.id);
  const total = dbTotal + (systemNotice ? 1 : 0);
  const offset = (page - 1) * pageSize;
  const dbOffset = systemNotice && page > 1 ? Math.max(0, offset - 1) : offset;
  const dbLimit = systemNotice && page === 1 ? Math.max(0, pageSize - 1) : pageSize;
  const { results } = dbLimit > 0
    ? await c.env.DB.prepare(
      `SELECT id, actor_name, type, post_id, reply_id, text_preview, is_read, created_at
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(user.id, dbLimit, dbOffset).all<{
      id: string;
      actor_name: string;
      type: string;
      post_id: string | null;
      reply_id: string | null;
      text_preview: string;
      is_read: number;
      created_at: number;
    }>()
    : { results: [] as Array<{
      id: string;
      actor_name: string;
      type: string;
      post_id: string | null;
      reply_id: string | null;
      text_preview: string;
      is_read: number;
      created_at: number;
    }> };
  return c.json({
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items: [
      ...(systemNotice && page === 1 ? [systemNotice] : []),
      ...results.map((row) => ({
        id: row.id,
        actorName: row.actor_name,
        type: row.type,
        postId: row.post_id,
        replyId: row.reply_id,
        textPreview: row.text_preview,
        isRead: Boolean(row.is_read),
        createdAt: row.created_at,
      })),
    ],
  });
});

app.post('/api/notifications/read', async (c) => {
  const user = requireUser(c);
  const body = await readJson(c, markNotificationsSchema);
  const systemNotice = await getSystemNoticeNotification(c.env, user.id);
  if (!body.markAll && (!body.ids || body.ids.length === 0)) {
    throw new ApiError(400, '缺少通知 ID');
  }
  if (body.markAll) {
    await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').bind(user.id).run();
    if (systemNotice && !systemNotice.isRead) {
      await markSystemNoticeRead(c.env, user.id, systemNotice.id);
    }
  } else {
    const ids = [...new Set(body.ids!)];
    const dbIds = systemNotice ? ids.filter((id) => id !== systemNotice.id) : ids;
    if (systemNotice && ids.includes(systemNotice.id)) {
      await markSystemNoticeRead(c.env, user.id, systemNotice.id);
    }
    if (dbIds.length > 0) {
      const placeholders = dbIds.map(() => '?').join(', ');
      await c.env.DB.prepare(
        `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${placeholders})`,
      ).bind(user.id, ...dbIds).run();
    }
  }
  await bumpCacheBuckets(c.env, ['notifications']);
  return c.json({ ok: true });
});

app.get('/api/admin/summary', async (c) => {
  requireAdminAccess(c);
  const summary = await readThroughCache(c.env, 'admin', 'summary', 15, async () => {
    const [users, posts, replies, unread, backups, deletedUsers, deletedPosts] = await Promise.all([
      c.env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE status != 'deleted'").first<{ total: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS total
         FROM posts
         JOIN users ON users.id = posts.author_id
         WHERE posts.is_deleted = 0 AND users.status != 'deleted'`,
      ).first<{ total: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS total
         FROM replies
         JOIN users ON users.id = replies.author_id
         JOIN posts ON posts.id = replies.post_id
         JOIN users AS post_authors ON post_authors.id = posts.author_id
         WHERE replies.is_deleted = 0
           AND users.status != 'deleted'
           AND posts.is_deleted = 0
           AND post_authors.status != 'deleted'`,
      ).first<{ total: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS total FROM notifications WHERE is_read = 0').first<{ total: number }>(),
      c.env.FORUM_KV.list({ prefix: 'backup:meta:' }),
      c.env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'deleted'").first<{ total: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS total FROM posts WHERE is_deleted = 1').first<{ total: number }>(),
    ]);
    return {
      users: Number(users?.total ?? 0),
      posts: Number(posts?.total ?? 0),
      replies: Number(replies?.total ?? 0),
      unreadNotifications: Number(unread?.total ?? 0),
      backups: backups.keys.length,
      deletedUsers: Number(deletedUsers?.total ?? 0),
      deletedPosts: Number(deletedPosts?.total ?? 0),
    };
  });
  return c.json(summary);
});

app.get('/api/admin/settings', async (c) => {
  requireAdminCapability(c, 'manageSettings', '需要论坛设置权限');
  return c.json(await loadAdminSettings(c.env, true));
});

app.put('/api/admin/settings', async (c) => {
  requireAdminCapability(c, 'manageSettings', '需要论坛设置权限');
  const body = await readJson(c, settingsSchema);
  const now = unixNow();
  const entries = [
    ['forum_title', body.forumTitle],
    ['forum_description', body.forumDescription],
    ['forum_keywords', body.forumKeywords],
    ['site_notice', body.siteNotice],
    ['turnstile_site_key', body.turnstileSiteKey],
    ['turnstile_secret_key', body.turnstileSecretKey],
    ['allow_registration', String(body.allowRegistration)],
    ['page_size_posts', String(body.pageSizePosts)],
    ['page_size_replies', String(body.pageSizeReplies)],
  ] as const;
  await c.env.DB.batch(entries.map(([key, value]) =>
    c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(key, value, now),
  ));
  await bumpCacheBuckets(c.env, ['meta']);
  return c.json({ ok: true });
});

app.get('/api/admin/boards', async (c) => {
  requireAdmin(c);
  return c.json(await loadBoards(c.env, true));
});

app.post('/api/admin/boards', async (c) => {
  requireAdmin(c);
  const body = await readJson(c, boardSchema);
  const exists = await c.env.DB.prepare('SELECT id FROM boards WHERE id = ? OR slug = ? LIMIT 1').bind(body.slug, body.slug).first();
  if (exists) {
    throw new ApiError(409, '板块标识已存在');
  }
  const now = unixNow();
  await c.env.DB.prepare(
    `INSERT INTO boards
    (id, slug, name, icon, description, accent, sort_order, is_visible, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(body.slug, body.slug, body.name, body.icon, body.description, body.accent, body.sortOrder, body.isVisible ? 1 : 0, now, now).run();
  await bumpCacheBuckets(c.env, ['meta', 'posts']);
  return c.json({ ok: true }, 201);
});

app.put('/api/admin/boards/:boardId', async (c) => {
  requireAdmin(c);
  const boardId = c.req.param('boardId');
  const body = await readJson(c, boardSchema);
  const conflict = await c.env.DB.prepare(
    'SELECT id FROM boards WHERE slug = ? AND id != ? LIMIT 1',
  ).bind(body.slug, boardId).first();
  if (conflict) {
    throw new ApiError(409, '板块 slug 已存在');
  }
  await c.env.DB.prepare(
    `UPDATE boards
     SET slug = ?, name = ?, icon = ?, description = ?, accent = ?, sort_order = ?, is_visible = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(body.slug, body.name, body.icon, body.description, body.accent, body.sortOrder, body.isVisible ? 1 : 0, unixNow(), boardId).run();
  await bumpCacheBuckets(c.env, ['meta', 'posts']);
  return c.json({ ok: true });
});

app.delete('/api/admin/boards/:boardId', async (c) => {
  requireAdmin(c);
  const boardId = c.req.param('boardId');
  const inUse = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM posts WHERE board_id = ?').bind(boardId).first<{ total: number }>();
  if (Number(inUse?.total ?? 0) > 0) {
    throw new ApiError(409, '板块下仍有帖子，不能删除');
  }
  await c.env.DB.prepare('DELETE FROM boards WHERE id = ?').bind(boardId).run();
  await bumpCacheBuckets(c.env, ['meta', 'posts']);
  return c.json({ ok: true });
});

app.get('/api/admin/users', async (c) => {
  requireAdminCapability(c, 'manageUsers', '需要会员管理权限');
  const page = parsePage(c.req.query('page'));
  const pageSize = 20;
  const q = cleanQuery(c.req.query('q'));
  const offset = (page - 1) * pageSize;
  const filters = ["status != 'deleted'"];
  const binds: Array<string | number> = [];
  if (q) {
    const like = `%${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    filters.push("(username_lower LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  const where = filters.join(' AND ');
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM users WHERE ${where}`).bind(...binds).first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, email, role, status, bio, created_at, last_login_at
     FROM users
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(...binds, pageSize, offset).all<{
    id: string;
    username: string;
    email: string;
    role: Role;
    status: AppUser['status'];
    bio: string;
    created_at: number;
    last_login_at: number | null;
  }>();
  return c.json({
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items: results.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      status: row.status,
      bio: row.bio,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    })),
  });
});

app.put('/api/admin/users/:userId', async (c) => {
  const current = requireAdminCapability(c, 'manageUsers', '需要会员管理权限');
  const capabilities = getAdminCapabilities(current);
  const userId = c.req.param('userId');
  const body = await readJson(c, updateUserSchema);
  const target = await c.env.DB.prepare(
    "SELECT id, role, status, bio FROM users WHERE id = ? AND status != 'deleted' LIMIT 1",
  ).bind(userId).first<{ id: string; role: Role; status: AppUser['status']; bio: string }>();
  if (!target) {
    throw new ApiError(404, '用户不存在');
  }
  if (!capabilities.manageUserRoles) {
    if (!capabilities.suspendUsers) {
      throw new ApiError(403, '没有权限停用会员');
    }
    if (target.role !== 'member') {
      throw new ApiError(403, '版主只能停用普通会员');
    }
    if (body.role !== target.role) {
      throw new ApiError(403, '版主不能修改会员角色');
    }
    if (body.bio !== undefined && body.bio !== target.bio) {
      throw new ApiError(403, '版主不能修改会员资料');
    }
    await c.env.DB.prepare(
      'UPDATE users SET status = ?, updated_at = ? WHERE id = ?',
    ).bind(body.status, unixNow(), userId).run();
    await bumpCacheBuckets(c.env, ['admin']);
    return c.json({ ok: true });
  }
  if (target.role === 'admin' && body.role !== 'admin') {
    await assertNotLastAdmin(c.env, userId);
  }
  await c.env.DB.prepare(
    'UPDATE users SET role = ?, status = ?, bio = COALESCE(?, bio), updated_at = ? WHERE id = ?',
  ).bind(body.role, body.status, body.bio ?? null, unixNow(), userId).run();
  await bumpCacheBuckets(c.env, ['admin', 'posts']);
  if (current.id === userId) {
    c.set('user', { ...current, role: body.role, status: body.status, bio: body.bio ?? current.bio });
  }
  return c.json({ ok: true });
});

app.delete('/api/admin/users/:userId', async (c) => {
  const current = requireAdminCapability(c, 'deleteUsers', '没有权限删除会员');
  const userId = c.req.param('userId');
  const target = await c.env.DB.prepare(
    "SELECT id, role FROM users WHERE id = ? AND status != 'deleted' LIMIT 1",
  ).bind(userId).first<{ id: string; role: Role }>();
  if (!target) {
    throw new ApiError(404, '用户不存在');
  }
  if (target.role === 'admin') {
    await assertNotLastAdmin(c.env, userId);
  }
  await softDeleteUsers(c.env, [userId]);
  await bumpCacheBuckets(c.env, ['admin', 'posts', 'notifications']);
  if (current.id === userId) {
    await clearSession(c);
  }
  return c.json({ ok: true });
});

app.post('/api/admin/users/batch-delete', async (c) => {
  const current = requireAdminCapability(c, 'deleteUsers', '没有权限删除会员');
  const body = await readJson(c, idBatchSchema);
  const ids = [...new Set(body.ids)];
  const placeholders = ids.map(() => '?').join(', ');
  const adminTotalRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status != 'deleted'",
  ).first<{ total: number }>();
  const adminTargetsRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM users
     WHERE role = 'admin' AND status != 'deleted' AND id IN (${placeholders})`,
  ).bind(...ids).first<{ total: number }>();
  const adminRemaining = Number(adminTotalRow?.total ?? 0) - Number(adminTargetsRow?.total ?? 0);
  if (Number(adminTargetsRow?.total ?? 0) > 0 && adminRemaining <= 0) {
    throw new ApiError(409, '至少需要保留一个管理员');
  }
  await softDeleteUsers(c.env, ids);
  await bumpCacheBuckets(c.env, ['admin', 'posts', 'notifications']);
  if (ids.includes(current.id)) {
    await clearSession(c);
  }
  return c.json({ ok: true });
});

app.get('/api/admin/recycle/users', async (c) => {
  requireAdminCapability(c, 'manageRecycle', '没有权限访问回收站');
  const page = parsePage(c.req.query('page'));
  const pageSize = 20;
  const q = cleanQuery(c.req.query('q'));
  const offset = (page - 1) * pageSize;
  const filters = ["status = 'deleted'"];
  const binds: Array<string | number> = [];
  if (q) {
    const like = `%${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    filters.push("(username_lower LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  const where = filters.join(' AND ');
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM users WHERE ${where}`).bind(...binds).first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, email, role, bio, created_at, last_login_at, deleted_at
     FROM users
     WHERE ${where}
     ORDER BY deleted_at DESC, updated_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(...binds, pageSize, offset).all<{
    id: string;
    username: string;
    email: string;
    role: Role;
    bio: string;
    created_at: number;
    last_login_at: number | null;
    deleted_at: number | null;
  }>();
  return c.json({
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items: results.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      bio: row.bio,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      deletedAt: row.deleted_at,
    })),
  });
});

app.post('/api/admin/recycle/users/restore', async (c) => {
  requireAdminCapability(c, 'manageRecycle', '没有权限访问回收站');
  const body = await readJson(c, idBatchSchema);
  await restoreUsers(c.env, body.ids);
  await bumpCacheBuckets(c.env, ['admin', 'posts', 'notifications']);
  return c.json({ ok: true });
});

app.post('/api/admin/recycle/users/purge', async (c) => {
  requireAdminCapability(c, 'manageRecycle', '没有权限清空回收站');
  const body = await readJson(c, idBatchSchema);
  await purgeUsers(c.env, body.ids);
  await bumpCacheBuckets(c.env, ['admin', 'posts', 'notifications']);
  return c.json({ ok: true });
});

app.get('/api/admin/posts', async (c) => {
  requireAdminCapability(c, 'managePosts', '需要帖子管理权限');
  const page = parsePage(c.req.query('page'));
  const pageSize = 20;
  const q = cleanQuery(c.req.query('q'));
  const offset = (page - 1) * pageSize;
  const filters = ['posts.is_deleted = 0', "users.status != 'deleted'"];
  const binds: Array<string | number> = [];
  if (q) {
    const like = `%${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    filters.push("(lower(posts.title) LIKE ? ESCAPE '\\' OR lower(posts.content_md) LIKE ? ESCAPE '\\' OR users.username_lower LIKE ? ESCAPE '\\')");
    binds.push(like, like, like);
  }
  const where = filters.join(' AND ');
  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM posts
     JOIN users ON users.id = posts.author_id
     WHERE ${where}`,
  ).bind(...binds).first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const { results } = await c.env.DB.prepare(
    `SELECT posts.id, posts.title, posts.reply_count, posts.like_count, posts.view_count, posts.is_pinned, posts.created_at, posts.last_activity_at,
            boards.name AS board_name, users.username AS author_name
     FROM posts
     JOIN boards ON boards.id = posts.board_id
     JOIN users ON users.id = posts.author_id
     WHERE ${where}
     ORDER BY posts.is_pinned DESC, posts.last_activity_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(...binds, pageSize, offset).all<{
    id: string;
    title: string;
    reply_count: number;
    like_count: number;
    view_count: number;
    is_pinned: number;
    created_at: number;
    last_activity_at: number;
    board_name: string;
    author_name: string;
  }>();
  return c.json({
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items: results.map((row) => ({
      id: row.id,
      title: row.title,
      replyCount: row.reply_count,
      likeCount: row.like_count,
      viewCount: row.view_count,
      isPinned: Boolean(row.is_pinned),
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      boardName: row.board_name,
      authorName: row.author_name,
    })),
  });
});

app.put('/api/admin/posts/:postId/pin', async (c) => {
  requireAdminCapability(c, 'managePosts', '需要帖子管理权限');
  const postId = c.req.param('postId');
  const body = await readJson(c, pinPostSchema);
  const result = await c.env.DB.prepare(
    'UPDATE posts SET is_pinned = ?, updated_at = ? WHERE id = ? AND is_deleted = 0',
  ).bind(body.isPinned ? 1 : 0, unixNow(), postId).run();
  if (Number(result.meta.changes ?? 0) === 0) {
    throw new ApiError(404, '帖子不存在');
  }
  await bumpCacheBuckets(c.env, ['posts', 'admin']);
  return c.json({ ok: true, isPinned: body.isPinned });
});

app.delete('/api/admin/posts/:postId', async (c) => {
  requireAdminCapability(c, 'managePosts', '需要帖子管理权限');
  const postId = c.req.param('postId');
  const exists = await c.env.DB.prepare('SELECT id FROM posts WHERE id = ? LIMIT 1').bind(postId).first();
  if (!exists) {
    throw new ApiError(404, '帖子不存在');
  }
  await softDeletePosts(c.env, [postId]);
  await bumpCacheBuckets(c.env, ['posts', 'admin', 'notifications']);
  return c.json({ ok: true });
});

app.post('/api/admin/posts/batch-delete', async (c) => {
  requireAdminCapability(c, 'managePosts', '需要帖子管理权限');
  const body = await readJson(c, idBatchSchema);
  await softDeletePosts(c.env, body.ids);
  await bumpCacheBuckets(c.env, ['posts', 'admin', 'notifications']);
  return c.json({ ok: true });
});

app.get('/api/admin/recycle/posts', async (c) => {
  requireAdminCapability(c, 'manageRecycle', '没有权限访问回收站');
  const page = parsePage(c.req.query('page'));
  const pageSize = 20;
  const q = cleanQuery(c.req.query('q'));
  const offset = (page - 1) * pageSize;
  const filters = ['posts.is_deleted = 1'];
  const binds: Array<string | number> = [];
  if (q) {
    const like = `%${q.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    filters.push("(lower(posts.title) LIKE ? ESCAPE '\\' OR lower(posts.content_md) LIKE ? ESCAPE '\\' OR users.username_lower LIKE ? ESCAPE '\\')");
    binds.push(like, like, like);
  }
  const where = filters.join(' AND ');
  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM posts
     JOIN users ON users.id = posts.author_id
     WHERE ${where}`,
  ).bind(...binds).first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const { results } = await c.env.DB.prepare(
    `SELECT posts.id, posts.title, posts.reply_count, posts.like_count, posts.view_count, posts.created_at,
            posts.last_activity_at, posts.deleted_at, boards.name AS board_name, users.username AS author_name
     FROM posts
     JOIN boards ON boards.id = posts.board_id
     JOIN users ON users.id = posts.author_id
     WHERE ${where}
     ORDER BY posts.deleted_at DESC, posts.updated_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(...binds, pageSize, offset).all<{
    id: string;
    title: string;
    reply_count: number;
    like_count: number;
    view_count: number;
    created_at: number;
    last_activity_at: number;
    deleted_at: number | null;
    board_name: string;
    author_name: string;
  }>();
  return c.json({
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items: results.map((row) => ({
      id: row.id,
      title: row.title,
      replyCount: row.reply_count,
      likeCount: row.like_count,
      viewCount: row.view_count,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      deletedAt: row.deleted_at,
      boardName: row.board_name,
      authorName: row.author_name,
    })),
  });
});

app.post('/api/admin/recycle/posts/restore', async (c) => {
  requireAdminCapability(c, 'manageRecycle', '没有权限访问回收站');
  const body = await readJson(c, idBatchSchema);
  await restorePosts(c.env, body.ids);
  await bumpCacheBuckets(c.env, ['posts', 'admin', 'notifications']);
  return c.json({ ok: true });
});

app.post('/api/admin/recycle/posts/purge', async (c) => {
  requireAdminCapability(c, 'manageRecycle', '没有权限清空回收站');
  const body = await readJson(c, idBatchSchema);
  await purgePosts(c.env, body.ids);
  await bumpCacheBuckets(c.env, ['posts', 'admin', 'notifications']);
  return c.json({ ok: true });
});

app.put('/api/admin/profile', async (c) => {
  const current = requireAdmin(c);
  const body = await readJson(c, adminProfileSchema);
  const dbUser = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ? LIMIT 1').bind(current.id).first<{ password_hash: string }>();
  if (!dbUser || !(await verifyPassword(body.currentPassword, dbUser.password_hash))) {
    throw new ApiError(401, '当前密码不正确');
  }
  if (body.username && body.username !== current.username) {
    await assertUniqueCredentials(c.env, body.username, null, current.id);
  }
  if (body.email && body.email.toLowerCase() !== current.email.toLowerCase()) {
    await assertUniqueCredentials(c.env, null, body.email, current.id);
  }
  await c.env.DB.prepare(
    `UPDATE users
     SET username = COALESCE(?, username),
         username_lower = COALESCE(lower(?), username_lower),
         email = COALESCE(lower(?), email),
         password_hash = COALESCE(?, password_hash),
         updated_at = ?
     WHERE id = ?`,
  ).bind(
    body.username ?? null,
    body.username ?? null,
    body.email ?? null,
    body.newPassword ? await hashPassword(body.newPassword) : null,
    unixNow(),
    current.id,
  ).run();
  const nextUser: AppUser = {
    ...current,
    username: body.username ?? current.username,
    email: body.email?.toLowerCase() ?? current.email,
  };
  await createSession(c, nextUser);
  await bumpCacheBuckets(c.env, ['admin', 'posts']);
  return c.json({ ok: true, user: publicUser(nextUser) });
});

app.get('/api/admin/backups', async (c) => {
  requireAdmin(c);
  const list = await c.env.FORUM_KV.list({ prefix: 'backup:meta:' });
  const metas = await Promise.all(list.keys.map((key) => c.env.FORUM_KV.get(key.name, 'json')));
  return c.json({
    items: metas
      .filter(Boolean)
      .map((item) => item as { id: string; label: string; createdAt: number })
      .sort((a, b) => b.createdAt - a.createdAt),
  });
});

app.get('/api/admin/backups/:backupId', async (c) => {
  requireAdmin(c);
  const raw = await c.env.FORUM_KV.get(`backup:data:${c.req.param('backupId')}`);
  if (!raw) {
    throw new ApiError(404, '备份不存在');
  }
  return new Response(raw, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="backup-${c.req.param('backupId')}.json"`,
    },
  });
});

app.post('/api/admin/backups', async (c) => {
  requireAdmin(c);
  const body = await readJson(c, backupSchema.catch({}));
  const backupId = createId('bak');
  const now = unixNow();
  const meta = {
    id: backupId,
    label: body.label ?? `手动备份 ${new Date(now * 1000).toISOString()}`,
    createdAt: now,
  };
  await Promise.all([
    c.env.FORUM_KV.put(`backup:data:${backupId}`, JSON.stringify(await exportForumData(c.env))),
    c.env.FORUM_KV.put(`backup:meta:${backupId}`, JSON.stringify(meta)),
  ]);
  return c.json({ ok: true, backupId, meta }, 201);
});

app.post('/api/admin/backups/:backupId/restore', async (c) => {
  requireAdmin(c);
  const raw = await c.env.FORUM_KV.get(`backup:data:${c.req.param('backupId')}`);
  if (!raw) {
    throw new ApiError(404, '备份不存在');
  }
  const snapshot = safeJsonParse<ForumSnapshot>(raw);
  if (!snapshot) {
    throw new ApiError(500, '备份数据损坏');
  }
  await restoreForumData(c.env, snapshot);
  await bumpCacheBuckets(c.env, ['meta', 'posts', 'notifications', 'admin']);
  return c.json({ ok: true });
});

app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: '接口不存在' }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json({ error: error.message }, error.status as 400);
  }
  if ((error as { name?: string }).name === 'ZodError') {
    const first = (error as ZodError).issues?.[0]?.message ?? '请求参数错误';
    return c.json({ error: first }, 400);
  }
  console.error(error);
  return c.json({ error: '服务器内部错误' }, 500);
});

async function resolvePublicBoardId(env: AppEnv['Bindings'], boardKey: string): Promise<string> {
  const key = boardKey.trim();
  if (!key) {
    return '';
  }
  const row = await env.DB.prepare(
    'SELECT id FROM boards WHERE id = ? OR slug = lower(?) LIMIT 1',
  ).bind(key, key).first<{ id: string }>();
  return row?.id ?? key;
}

type NotificationFeedItem = {
  id: string;
  actorName: string;
  type: string;
  postId: string | null;
  replyId: string | null;
  textPreview: string;
  isRead: boolean;
  createdAt: number;
};

async function getUserNotificationUnreadCount(env: AppEnv['Bindings'], userId: string): Promise<number> {
  const [dbUnread, systemNotice] = await Promise.all([
    getUnreadNotificationCount(env, userId),
    getSystemNoticeNotification(env, userId),
  ]);
  return dbUnread + (systemNotice && !systemNotice.isRead ? 1 : 0);
}

async function getSystemNoticeNotification(env: AppEnv['Bindings'], userId: string): Promise<NotificationFeedItem | null> {
  const row = await env.DB.prepare(
    "SELECT value, updated_at FROM settings WHERE key = 'site_notice' LIMIT 1",
  ).first<{ value: string; updated_at: number }>();
  const text = row?.value?.trim() ?? '';
  if (!text) {
    return null;
  }
  const createdAt = Number(row?.updated_at ?? unixNow());
  const id = `system_notice_${createdAt}`;
  const isRead = await isSystemNoticeRead(env, userId, id);
  return {
    id,
    actorName: '系统',
    type: 'system_notice',
    postId: null,
    replyId: null,
    textPreview: text.slice(0, 160),
    isRead,
    createdAt,
  };
}

async function isSystemNoticeRead(env: AppEnv['Bindings'], userId: string, noticeId: string): Promise<boolean> {
  return (await env.FORUM_KV.get(`notification:system-read:${userId}:${noticeId}`)) === '1';
}

async function markSystemNoticeRead(env: AppEnv['Bindings'], userId: string, noticeId: string): Promise<void> {
  await env.FORUM_KV.put(`notification:system-read:${userId}:${noticeId}`, '1');
}

export default app;
