import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_INPUT = 'dz.sql';
const DEFAULT_OUTPUT = 'discuz-import.sql';
const BOARD_ACCENTS = ['#69c6dc', '#ffb65d', '#65d8a6', '#ff7f7f', '#ff5b5b', '#7c90ff', '#8bb174', '#d99873'];
const CONTENT_UPDATE_MAX_BYTES = 24_000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = path.resolve(process.cwd(), args.input ?? DEFAULT_INPUT);
  const outputPath = path.resolve(process.cwd(), args.output ?? DEFAULT_OUTPUT);
  const dump = await fs.readFile(inputPath, 'utf8');
  const rawData = {
    settings: parseTableRows(dump, 'pre_common_setting'),
    forums: parseTableRows(dump, 'pre_forum_forum'),
    members: parseTableRows(dump, 'pre_common_member'),
    ucenterMembers: parseTableRows(dump, 'pre_ucenter_members'),
    threads: parseTableRows(dump, 'pre_forum_thread'),
    posts: parseTableRows(dump, 'pre_forum_post'),
  };

  const payload = buildImportPayload(rawData, inputPath);
  const sql = renderImportSql(payload, inputPath);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, sql, 'utf8');

  console.log(`Generated: ${path.relative(process.cwd(), outputPath) || path.basename(outputPath)}`);
  console.log(`Boards: ${payload.summary.boards}`);
  console.log(`Users: ${payload.summary.users}`);
  console.log(`Posts: ${payload.summary.posts}`);
  console.log(`Replies: ${payload.summary.replies}`);
  if (payload.summary.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of payload.summary.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--input' || arg === '-i') {
      result.input = requireNextArg(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--output' || arg === '-o') {
      result.output = requireNextArg(args, i, arg);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function requireNextArg(args, index, flag) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log('Usage: node scripts/import-discuz.mjs [--input dz.sql] [--output discuz-import.sql]');
  console.log('Defaults:');
  console.log(`  input  = ${DEFAULT_INPUT}`);
  console.log(`  output = ${DEFAULT_OUTPUT}`);
}

function buildImportPayload(rawData) {
  assertTablePresent(rawData.forums, 'pre_forum_forum');
  assertTablePresent(rawData.members, 'pre_common_member');
  assertTablePresent(rawData.threads, 'pre_forum_thread');
  assertTablePresent(rawData.posts, 'pre_forum_post');

  const now = unixNow();
  const warningCounts = {
    renamedUsers: 0,
    replacedEmails: 0,
    missingUcenterPasswords: 0,
    syntheticUsers: 0,
    missingFirstPosts: 0,
  };

  const settingsMap = new Map(rawData.settings.map((row) => [String(row[0] ?? ''), String(row[1] ?? '')]));
  const forumRows = rawData.forums.map(parseForumRow);
  const forumById = new Map(forumRows.map((row) => [row.fid, row]));
  const boards = buildBoards(forumRows, forumById, now);
  const boardsByFid = new Map(boards.map((row) => [row.sourceFid, row]));

  const usedUsernames = new Set();
  const usedUsernameLower = new Set();
  const usedEmails = new Set();
  const userRecords = [];
  const usersByKey = new Map();
  const usersByUid = new Map();
  let syntheticUserSequence = 0;

  const ucenterByUid = new Map(rawData.ucenterMembers.map((row) => {
    const parsed = parseUcenterMemberRow(row);
    return [parsed.uid, parsed];
  }));

  for (const member of rawData.members.map(parseMemberRow).sort((a, b) => a.uid - b.uid)) {
    const ucenter = ucenterByUid.get(member.uid);
    if (!ucenter || !ucenter.password) {
      warningCounts.missingUcenterPasswords += 1;
    }
    const user = registerUser({
      key: `uid:${member.uid}`,
      id: `dz-u-${member.uid}`,
      username: member.username || ucenter?.username || `user${member.uid}`,
      email: ucenter?.email || member.email,
      emailFallbackPrefix: `discuz-user-${member.uid}`,
      usernameDisambiguator: `u${member.uid}`,
      passwordHash: ucenter?.password
        ? `discuzmd5:${ucenter.salt}:${ucenter.password}`
        : 'disabled',
      role: mapDiscuzRole(member),
      status: mapDiscuzStatus(member),
      createdAt: clampUnix(member.regdate, now),
      bio: '',
    });
    usersByUid.set(member.uid, user.id);
  }

  const threadRows = rawData.threads
    .map(parseThreadRow)
    .filter((row) => boardsByFid.has(row.fid))
    .sort((a, b) => a.dateline - b.dateline || a.tid - b.tid);
  const threadsById = new Map(threadRows.map((row) => [row.tid, row]));

  const postBuckets = new Map();
  for (const post of rawData.posts.map(parsePostRow)) {
    if (!threadsById.has(post.tid)) {
      continue;
    }
    const bucket = postBuckets.get(post.tid) ?? { firstPost: null, replies: [] };
    if (post.first) {
      if (!bucket.firstPost || comparePostOrder(post, bucket.firstPost) < 0) {
        bucket.firstPost = post;
      }
    } else {
      bucket.replies.push(post);
    }
    postBuckets.set(post.tid, bucket);
  }

  const posts = [];
  const replies = [];

  for (const thread of threadRows) {
    const bucket = postBuckets.get(thread.tid) ?? { firstPost: null, replies: [] };
    const firstPost = bucket.firstPost;
    if (!firstPost) {
      warningCounts.missingFirstPosts += 1;
    }

    const allReplies = bucket.replies.sort(comparePostOrder);
    const visibleReplies = allReplies.filter((row) => row.invisible === 0);
    const postId = `dz-p-${thread.tid}`;
    const createdAt = clampUnix(firstPost?.dateline || thread.dateline, now);
    const updatedAt = Math.max(
      createdAt,
      clampUnix(thread.lastpost, createdAt),
      ...allReplies.map((row) => clampUnix(row.dateline, createdAt)),
    );
    const lastActivityAt = Math.max(
      createdAt,
      ...visibleReplies.map((row) => clampUnix(row.dateline, createdAt)),
    );
    const isDeleted = thread.displayorder < 0 || thread.hidden > 0 || Boolean(firstPost && firstPost.invisible !== 0);
    const postAuthorId = resolveAuthorId(thread.authorid, thread.author, createdAt);
    const content = firstPost
      ? discuzToMarkdown(firstPost.message, {
        hasAttachment: thread.attachment > 0 || firstPost.attachment > 0,
      })
      : `Discuz first post missing for thread ${thread.tid}.`;

    posts.push({
      id: postId,
      board_id: boardsByFid.get(thread.fid).id,
      author_id: postAuthorId,
      title: cleanTitle(thread.subject || firstPost?.subject || `Discuz thread ${thread.tid}`),
      content_md: content,
      like_count: Math.max(0, thread.recommends),
      reply_count: visibleReplies.length,
      view_count: Math.max(0, thread.views),
      is_pinned: thread.displayorder > 0 ? 1 : 0,
      is_deleted: isDeleted ? 1 : 0,
      created_at: createdAt,
      updated_at: updatedAt,
      last_activity_at: isDeleted ? createdAt : lastActivityAt,
    });

    for (const reply of allReplies) {
      const replyCreatedAt = clampUnix(reply.dateline, createdAt);
      replies.push({
        id: `dz-r-${reply.pid}`,
        post_id: postId,
        author_id: resolveAuthorId(reply.authorid, reply.author, replyCreatedAt),
        content_md: discuzToMarkdown(reply.message, { hasAttachment: reply.attachment > 0 }),
        like_count: 0,
        is_deleted: reply.invisible === 0 ? 0 : 1,
        created_at: replyCreatedAt,
        updated_at: replyCreatedAt,
      });
    }
  }

  const settings = buildSettings(settingsMap, now);

  const warnings = [];
  if (warningCounts.renamedUsers > 0) {
    warnings.push(`${warningCounts.renamedUsers} imported usernames were adjusted to satisfy uniqueness constraints.`);
  }
  if (warningCounts.replacedEmails > 0) {
    warnings.push(`${warningCounts.replacedEmails} invalid or duplicate emails were replaced with import.local addresses.`);
  }
  if (warningCounts.missingUcenterPasswords > 0) {
    warnings.push(`${warningCounts.missingUcenterPasswords} users were imported without legacy password hashes and cannot log in until you reset their passwords.`);
  }
  if (warningCounts.syntheticUsers > 0) {
    warnings.push(`${warningCounts.syntheticUsers} synthetic users were created for guest or missing authors.`);
  }
  if (warningCounts.missingFirstPosts > 0) {
    warnings.push(`${warningCounts.missingFirstPosts} threads were missing first-post rows and were imported with placeholder content.`);
  }

  return {
    settings,
    boards: boards.map(stripBoardSourceFields),
    users: userRecords,
    posts,
    replies,
    summary: {
      boards: boards.length,
      users: userRecords.length,
      posts: posts.length,
      replies: replies.length,
      warnings,
    },
  };

  function registerUser(input) {
    const existing = usersByKey.get(input.key);
    if (existing) {
      return existing;
    }

    const usernameInfo = makeUniqueUsername(
      input.username,
      input.usernameDisambiguator,
      usedUsernames,
      usedUsernameLower,
    );
    if (usernameInfo.changed) {
      warningCounts.renamedUsers += 1;
    }

    const emailInfo = makeUniqueEmail(input.email, input.emailFallbackPrefix, usedEmails);
    if (emailInfo.changed) {
      warningCounts.replacedEmails += 1;
    }

    const record = {
      id: input.id,
      username: usernameInfo.username,
      username_lower: usernameInfo.usernameLower,
      email: emailInfo.email,
      password_hash: input.passwordHash,
      role: input.role,
      status: input.status,
      bio: input.bio,
      created_at: clampUnix(input.createdAt, now),
      updated_at: clampUnix(input.createdAt, now),
      last_login_at: null,
    };
    userRecords.push(record);
    usersByKey.set(input.key, record);
    return record;
  }

  function resolveAuthorId(authorId, authorName, createdAt) {
    if (authorId > 0 && usersByUid.has(authorId)) {
      return usersByUid.get(authorId);
    }

    const normalizedName = sanitizeDisplayName(authorName);
    const syntheticKey = authorId > 0
      ? `missing:${authorId}`
      : `guest:${normalizedName || 'anonymous'}`;
    const syntheticId = authorId > 0
      ? `dz-u-missing-${authorId}`
      : `dz-u-guest-${++syntheticUserSequence}`;
    const syntheticUser = registerUser({
      key: syntheticKey,
      id: syntheticId,
      username: authorId > 0
        ? (normalizedName || `DiscuzUser${authorId}`)
        : (normalizedName ? `游客_${normalizedName}` : '匿名用户'),
      email: '',
      emailFallbackPrefix: authorId > 0
        ? `discuz-missing-${authorId}`
        : `discuz-guest-${syntheticUserSequence}`,
      usernameDisambiguator: authorId > 0
        ? `missing${authorId}`
        : `guest${syntheticUserSequence}`,
      passwordHash: 'disabled',
      role: 'member',
      status: 'active',
      createdAt,
      bio: authorId > 0
        ? `Discuz UID ${authorId} was referenced by content but missing from the member table.`
        : 'Imported guest author.',
    });

    if (authorId > 0) {
      usersByUid.set(authorId, syntheticUser.id);
    }
    warningCounts.syntheticUsers += 1;
    return syntheticUser.id;
  }
}

function assertTablePresent(rows, tableName) {
  if (rows.length === 0) {
    throw new Error(`No INSERT rows found for ${tableName}`);
  }
}

function buildBoards(forumRows, forumById, now) {
  return forumRows
    .filter((row) => row.type === 'forum' || row.type === 'sub')
    .sort((left, right) => compareForumOrder(left, right, forumById))
    .map((row, index) => {
      const ancestors = buildForumChain(row, forumById).slice(0, -1);
      const descriptionParts = [];
      if (row.type === 'sub') {
        descriptionParts.push('Discuz 子版块');
      }
      if (ancestors.length > 0) {
        descriptionParts.push(`原分区: ${ancestors.map((item) => cleanText(item.name)).filter(Boolean).join(' / ')}`);
      }
      return {
        id: `dz-${row.fid}`,
        slug: `dz-${row.fid}`,
        name: trimToLength(cleanText(row.name) || `Board ${row.fid}`, 30),
        icon: pickBoardIcon(row.name),
        description: trimToLength(descriptionParts.join(' | '), 120),
        accent: BOARD_ACCENTS[index % BOARD_ACCENTS.length],
        sort_order: index + 1,
        is_visible: row.status > 0 ? 1 : 0,
        created_at: now,
        updated_at: now,
        sourceFid: row.fid,
      };
    });
}

function buildSettings(settingsMap, now) {
  const title = trimToLength(
    cleanText(settingsMap.get('sitename') || settingsMap.get('bbname') || 'Discuz Import'),
    60,
  ) || 'Discuz Import';
  const siteUrl = cleanText(settingsMap.get('siteurl'));
  const keywords = trimToLength(
    cleanCommaList(settingsMap.get('srchhotkeywords')) || 'discuz,import',
    200,
  );
  const description = trimToLength(
    siteUrl ? `原站地址: ${siteUrl}` : '从 Discuz 导入的历史论坛数据。',
    160,
  );

  return [
    { key: 'forum_title', value: title, updated_at: now },
    { key: 'forum_description', value: description, updated_at: now },
    { key: 'forum_keywords', value: keywords, updated_at: now },
    { key: 'site_notice', value: 'Discuz 历史数据已导入。原始附件和 UCenter 扩展资料未迁移。', updated_at: now },
    { key: 'allow_registration', value: settingsMap.get('regstatus') === '1' ? 'true' : 'false', updated_at: now },
    { key: 'page_size_posts', value: String(clampNumber(settingsMap.get('topicperpage'), 12, 5, 50)), updated_at: now },
    { key: 'page_size_replies', value: String(clampNumber(settingsMap.get('postperpage'), 15, 5, 50)), updated_at: now },
  ];
}

function stripBoardSourceFields(board) {
  const { sourceFid, ...rest } = board;
  return rest;
}

function renderImportSql(payload, inputPath) {
  const lines = [
    '-- Generated by scripts/import-discuz.mjs',
    `-- Source: ${path.basename(inputPath)}`,
    `-- Generated at: ${new Date().toISOString()}`,
    'PRAGMA foreign_keys = OFF;',
    'BEGIN TRANSACTION;',
    'DELETE FROM notifications;',
    'DELETE FROM likes;',
    'DELETE FROM replies;',
    'DELETE FROM posts;',
    'DELETE FROM users;',
    'DELETE FROM boards;',
    'DELETE FROM settings;',
  ];

  appendInsertStatements(lines, 'settings', ['key', 'value', 'updated_at'], payload.settings, 50);
  appendInsertStatements(lines, 'boards', ['id', 'slug', 'name', 'icon', 'description', 'accent', 'sort_order', 'is_visible', 'created_at', 'updated_at'], payload.boards, 50);
  appendInsertStatements(lines, 'users', ['id', 'username', 'username_lower', 'email', 'password_hash', 'role', 'status', 'bio', 'created_at', 'updated_at', 'last_login_at'], payload.users, 100);
  appendLargeTextRows(
    lines,
    'posts',
    ['id', 'board_id', 'author_id', 'title', 'content_md', 'like_count', 'reply_count', 'view_count', 'is_pinned', 'is_deleted', 'created_at', 'updated_at', 'last_activity_at'],
    payload.posts,
    'id',
    'content_md',
    100,
  );
  appendLargeTextRows(
    lines,
    'replies',
    ['id', 'post_id', 'author_id', 'content_md', 'like_count', 'is_deleted', 'created_at', 'updated_at'],
    payload.replies,
    'id',
    'content_md',
    200,
  );

  lines.push('COMMIT;');
  lines.push('PRAGMA foreign_keys = ON;');
  return `${lines.join('\n')}\n`;
}

function appendInsertStatements(lines, tableName, columns, rows, chunkSize) {
  if (rows.length === 0) {
    return;
  }

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const values = chunk.map((row) => (
      `  (${columns.map((column) => sqlLiteral(row[column])).join(', ')})`
    ));
    lines.push(`INSERT INTO ${tableName} (${columns.join(', ')}) VALUES`);
    lines.push(`${values.join(',\n')};`);
  }
}

function appendLargeTextRows(lines, tableName, columns, rows, keyColumn, textColumn, chunkSize) {
  if (rows.length === 0) {
    return;
  }

  const insertRows = rows.map((row) => ({
    ...row,
    [textColumn]: '',
  }));
  appendInsertStatements(lines, tableName, columns, insertRows, chunkSize);

  for (const row of rows) {
    const value = String(row[textColumn] ?? '');
    if (!value) {
      continue;
    }

    const chunks = splitSqlStringChunks(value, CONTENT_UPDATE_MAX_BYTES);
    chunks.forEach((chunk, index) => {
      const assignment = index === 0
        ? `${textColumn} = ${sqlLiteral(chunk)}`
        : `${textColumn} = ${textColumn} || ${sqlLiteral(chunk)}`;
      lines.push(`UPDATE ${tableName} SET ${assignment} WHERE ${keyColumn} = ${sqlLiteral(row[keyColumn])};`);
    });
  }
}

function parseTableRows(sql, tableName) {
  const blocks = extractInsertBlocks(sql, tableName);
  const rows = [];
  for (const block of blocks) {
    rows.push(...parseValueBlock(block));
  }
  return rows;
}

function extractInsertBlocks(sql, tableName) {
  const marker = `INSERT INTO \`${tableName}\` VALUES `;
  const blocks = [];
  let searchFrom = 0;

  while (searchFrom < sql.length) {
    const start = sql.indexOf(marker, searchFrom);
    if (start === -1) {
      break;
    }
    const valueStart = start + marker.length;
    const end = findStatementEnd(sql, valueStart);
    blocks.push(sql.slice(valueStart, end));
    searchFrom = end + 1;
  }

  return blocks;
}

function findStatementEnd(sql, valueStart) {
  let inString = false;
  let escaped = false;

  for (let index = valueStart; index < sql.length; index += 1) {
    const char = sql[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '\'') {
        inString = false;
      }
      continue;
    }

    if (char === '\'') {
      inString = true;
      continue;
    }
    if (char === ';') {
      return index;
    }
  }

  throw new Error('Unterminated INSERT statement in dump.');
}

function parseValueBlock(block) {
  const rows = [];
  let index = 0;

  while (index < block.length) {
    index = skipWhitespaceAndCommas(block, index);
    if (index >= block.length) {
      break;
    }
    if (block[index] !== '(') {
      throw new Error(`Unexpected token while parsing VALUES block: ${block[index]}`);
    }
    const { row, nextIndex } = parseTuple(block, index + 1);
    rows.push(row);
    index = nextIndex;
  }

  return rows;
}

function skipWhitespaceAndCommas(text, startIndex) {
  let index = startIndex;
  while (index < text.length && /[\s,]/u.test(text[index])) {
    index += 1;
  }
  return index;
}

function parseTuple(text, startIndex) {
  const row = [];
  let token = '';
  let inString = false;
  let escaped = false;
  let index = startIndex;

  while (index < text.length) {
    const char = text[index];
    if (inString) {
      token += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '\'') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '\'') {
      token += char;
      inString = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      row.push(parseSqlToken(token));
      token = '';
      index += 1;
      continue;
    }
    if (char === ')') {
      row.push(parseSqlToken(token));
      return { row, nextIndex: index + 1 };
    }

    token += char;
    index += 1;
  }

  throw new Error('Unterminated tuple in VALUES block.');
}

function parseSqlToken(token) {
  const trimmed = token.trim();
  if (trimmed === 'NULL') {
    return null;
  }
  if (trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
    return unescapeMysqlString(trimmed.slice(1, -1));
  }
  if (/^-?\d+$/u.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed;
}

function unescapeMysqlString(value) {
  let result = '';
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!escaped) {
      if (char === '\\') {
        escaped = true;
      } else {
        result += char;
      }
      continue;
    }

    escaped = false;
    switch (char) {
      case '0':
        result += '\0';
        break;
      case 'b':
        result += '\b';
        break;
      case 'n':
        result += '\n';
        break;
      case 'r':
        result += '\r';
        break;
      case 't':
        result += '\t';
        break;
      case 'Z':
        result += '\x1A';
        break;
      case '\'':
      case '"':
      case '\\':
        result += char;
        break;
      default:
        result += char;
        break;
    }
  }

  if (escaped) {
    result += '\\';
  }

  return result;
}

function parseForumRow(row) {
  return {
    fid: Number(row[0] ?? 0),
    fup: Number(row[1] ?? 0),
    type: String(row[2] ?? ''),
    name: String(row[3] ?? ''),
    status: Number(row[4] ?? 0),
    displayorder: Number(row[5] ?? 0),
  };
}

function parseMemberRow(row) {
  return {
    uid: Number(row[0] ?? 0),
    email: String(row[1] ?? ''),
    username: String(row[2] ?? ''),
    status: Number(row[4] ?? 0),
    adminid: Number(row[8] ?? 0),
    groupid: Number(row[9] ?? 0),
    regdate: Number(row[12] ?? 0),
  };
}

function parseUcenterMemberRow(row) {
  return {
    uid: Number(row[0] ?? 0),
    username: String(row[1] ?? ''),
    password: String(row[2] ?? ''),
    email: String(row[3] ?? ''),
    regdate: Number(row[7] ?? 0),
    salt: String(row[10] ?? ''),
  };
}

function parseThreadRow(row) {
  return {
    tid: Number(row[0] ?? 0),
    fid: Number(row[1] ?? 0),
    author: String(row[7] ?? ''),
    authorid: Number(row[8] ?? 0),
    subject: String(row[9] ?? ''),
    dateline: Number(row[10] ?? 0),
    lastpost: Number(row[11] ?? 0),
    views: Number(row[13] ?? 0),
    replies: Number(row[14] ?? 0),
    displayorder: Number(row[15] ?? 0),
    attachment: Number(row[20] ?? 0),
    recommends: Number(row[24] ?? 0),
    hidden: Number(row[41] ?? 0),
  };
}

function parsePostRow(row) {
  return {
    pid: Number(row[0] ?? 0),
    tid: Number(row[2] ?? 0),
    first: Number(row[3] ?? 0) === 1,
    author: String(row[4] ?? ''),
    authorid: Number(row[5] ?? 0),
    subject: String(row[6] ?? ''),
    dateline: Number(row[7] ?? 0),
    message: String(row[8] ?? ''),
    invisible: Number(row[11] ?? 0),
    attachment: Number(row[18] ?? 0),
    position: Number(row[25] ?? 0),
  };
}

function compareForumOrder(left, right, forumById) {
  const leftChain = buildForumChain(left, forumById);
  const rightChain = buildForumChain(right, forumById);
  const maxLength = Math.max(leftChain.length, rightChain.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftNode = leftChain[index];
    const rightNode = rightChain[index];
    if (!leftNode) {
      return -1;
    }
    if (!rightNode) {
      return 1;
    }
    const diff = leftNode.displayorder - rightNode.displayorder || leftNode.fid - rightNode.fid;
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function buildForumChain(row, forumById) {
  const chain = [];
  let current = row;
  let guard = 0;

  while (current && guard < 10) {
    chain.unshift(current);
    current = forumById.get(current.fup) ?? null;
    guard += 1;
  }

  return chain;
}

function comparePostOrder(left, right) {
  return left.position - right.position || left.pid - right.pid;
}

function mapDiscuzRole(member) {
  if (member.adminid === 1 || member.groupid === 1) {
    return 'admin';
  }
  if (member.adminid > 1) {
    return 'moderator';
  }
  return 'member';
}

function mapDiscuzStatus(member) {
  if (member.status !== 0 || member.adminid < 0) {
    return 'suspended';
  }
  return 'active';
}

function makeUniqueUsername(rawValue, disambiguator, usedUsernames, usedUsernameLower) {
  const base = sanitizeDisplayName(rawValue) || `user_${disambiguator}`;
  let candidate = base;
  let changed = false;
  let attempt = 0;

  while (!candidate || usedUsernames.has(candidate) || usedUsernameLower.has(candidate.toLowerCase())) {
    attempt += 1;
    candidate = `${base}_${disambiguator}${attempt > 1 ? attempt : ''}`;
    changed = true;
  }

  usedUsernames.add(candidate);
  usedUsernameLower.add(candidate.toLowerCase());
  return {
    username: candidate,
    usernameLower: candidate.toLowerCase(),
    changed,
  };
}

function makeUniqueEmail(rawValue, fallbackPrefix, usedEmails) {
  const normalized = sanitizeEmail(rawValue);
  let candidate = isProbablyEmail(normalized)
    ? normalized
    : `${fallbackPrefix}@import.local`;
  let changed = candidate !== normalized;
  let attempt = 0;

  while (usedEmails.has(candidate.toLowerCase())) {
    attempt += 1;
    candidate = `${fallbackPrefix}-${attempt}@import.local`;
    changed = true;
  }

  usedEmails.add(candidate.toLowerCase());
  return { email: candidate, changed };
}

function pickBoardIcon(name) {
  const cleaned = cleanText(name).replace(/[\s\p{P}\p{S}]+/gu, '');
  return cleaned.slice(0, 1) || '版';
}

function cleanTitle(value) {
  return trimToLength(cleanText(stripSimpleBbcode(value)), 120) || 'Untitled';
}

function cleanText(value) {
  return sanitizeDisplayName(decodeHtmlEntities(String(value ?? '')));
}

function cleanCommaList(value) {
  return cleanText(value).replace(/[\s,]+/gu, ',').replace(/^,+|,+$/gu, '');
}

function sanitizeDisplayName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function sanitizeEmail(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]+/gu, '')
    .trim()
    .toLowerCase();
}

function isProbablyEmail(value) {
  return /^[^\s@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/iu.test(value);
}

function trimToLength(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function clampUnix(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function discuzToMarkdown(rawValue, options = {}) {
  let text = normalizeLineEndings(String(rawValue ?? ''));
  text = text.replace(/\n*\[\[i\][\s\S]*?\[\/i\]\]/giu, '');
  text = decodeHtmlEntities(text);
  text = replaceUntilStable(
    text,
    /\[code\]([\s\S]*?)\[\/code\]/iu,
    (_, content) => `\n\n\`\`\`\n${normalizeLineEndings(content).trim()}\n\`\`\`\n\n`,
  );
  text = replaceUntilStable(
    text,
    /\[quote(?:=[^\]]+)?\]([\s\S]*?)\[\/quote\]/iu,
    (_, content) => `\n\n${toBlockquote(stripSimpleBbcode(content))}\n\n`,
  );
  text = text.replace(/\[attachimg\][\s\S]*?\[\/attachimg\]/giu, '\n\n[图片附件未导入]\n\n');
  text = text.replace(/\[attach\][\s\S]*?\[\/attach\]/giu, '\n\n[附件未导入]\n\n');
  text = text.replace(/\[img(?:=[^\]]+)?\]([\s\S]*?)\[\/img\]/giu, (_, url) => {
    const normalizedUrl = cleanLinkTarget(url);
    return normalizedUrl ? `![](${normalizedUrl})` : '';
  });
  text = text.replace(/\[url\]([\s\S]*?)\[\/url\]/giu, (_, url) => formatMarkdownLink(url, url));
  text = text.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/giu, (_, url, label) => formatMarkdownLink(url, label));
  text = text.replace(/\[email\]([\s\S]*?)\[\/email\]/giu, (_, email) => formatMarkdownMailto(email, email));
  text = text.replace(/\[email=([^\]]+)\]([\s\S]*?)\[\/email\]/giu, (_, email, label) => formatMarkdownMailto(email, label));
  text = text.replace(/\[hr\]/giu, '\n\n---\n\n');
  text = text.replace(/\[br\]/giu, '\n');
  text = text.replace(/\[(?:audio|media|flash)[^\]]*\]([\s\S]*?)\[\/(?:audio|media|flash)\]/giu, (_, url) => {
    const normalizedUrl = cleanLinkTarget(url);
    return normalizedUrl ? `\n\n媒体: ${normalizedUrl}\n\n` : '';
  });
  text = text.replace(/\[hide(?:=[^\]]*)?\]([\s\S]*?)\[\/hide\]/giu, (_, content) => {
    const normalized = cleanMarkdownBlock(content);
    return normalized ? `\n\n[隐藏内容]\n${normalized}\n\n` : '\n\n[隐藏内容]\n\n';
  });
  text = text.replace(/\[list(?:=[^\]]+)?\]/giu, '\n');
  text = text.replace(/\[\/list\]/giu, '\n');
  text = text.replace(/\[\*\]/gu, '\n- ');
  text = text.replace(/\[(?:font|size|color|align|backcolor|indent|p|center|left|right|float|table|tr|td|th)[^\]]*\]/giu, '');
  text = text.replace(/\[\/(?:font|size|color|align|backcolor|indent|p|center|left|right|float|table|tr|td|th)\]/giu, '');
  text = text.replace(/\[b\]/giu, '**');
  text = text.replace(/\[\/b\]/giu, '**');
  text = text.replace(/\[i\]/giu, '*');
  text = text.replace(/\[\/i\]/giu, '*');
  text = text.replace(/\[s\]/giu, '~~');
  text = text.replace(/\[\/s\]/giu, '~~');
  text = text.replace(/\[u\]|\[\/u\]|\[sup\]|\[\/sup\]|\[sub\]|\[\/sub\]/giu, '');
  text = text.replace(/\[(?:\/)?(?:size|font|color|align|backcolor|indent|p|center|left|right|float|table|tr|td|th|list|quote|code|hide|attach|attachimg|audio|media|flash)\b[^\]]*\]/giu, '');
  text = cleanMarkdownBlock(text);

  if (options.hasAttachment && !text.includes('[附件未导入]') && !text.includes('[图片附件未导入]')) {
    text = text ? `${text}\n\n[附件未导入]` : '[附件未导入]';
  }

  return text || '（空内容）';
}

function cleanMarkdownBlock(value) {
  return normalizeLineEndings(stripSimpleBbcode(value))
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function stripSimpleBbcode(value) {
  return String(value ?? '').replace(/\[(?:\/)?[a-z]+[^\]]*\]/giu, '');
}

function cleanLinkTarget(value) {
  return cleanText(value).replace(/\s+/gu, '');
}

function formatMarkdownLink(url, label) {
  const target = cleanLinkTarget(url);
  if (!target) {
    return cleanText(label);
  }
  const text = cleanText(label) || target;
  return `[${text}](${target})`;
}

function formatMarkdownMailto(email, label) {
  const normalizedEmail = sanitizeEmail(email);
  const text = cleanText(label) || normalizedEmail;
  return normalizedEmail ? `[${text}](mailto:${normalizedEmail})` : text;
}

function toBlockquote(value) {
  const normalized = cleanMarkdownBlock(value);
  if (!normalized) {
    return '> ';
  }
  return normalized
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function replaceUntilStable(input, pattern, replacer) {
  let text = input;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const next = text.replace(pattern, replacer);
    if (next === text) {
      break;
    }
    text = next;
  }
  return text;
}

function normalizeLineEndings(value) {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '');
}

function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/giu, (_, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') {
      return '&';
    }
    if (lower === 'lt') {
      return '<';
    }
    if (lower === 'gt') {
      return '>';
    }
    if (lower === 'quot') {
      return '"';
    }
    if (lower === 'apos') {
      return '\'';
    }
    if (lower === 'nbsp') {
      return ' ';
    }
    if (lower.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return _;
  });
}

function sqlLiteral(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '0';
  }
  return sqlStringExpression(String(value));
}

function splitSqlStringChunks(value, maxBytes) {
  const chunks = [];
  let current = '';

  for (const char of String(value)) {
    const next = current + char;
    if (current && Buffer.byteLength(next, 'utf8') > maxBytes) {
      chunks.push(current);
      current = char;
      continue;
    }
    current = next;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function sqlStringExpression(value) {
  const parts = String(value).split(';');
  if (parts.length === 1) {
    return `'${parts[0].replace(/'/gu, '\'\'')}'`;
  }
  return parts
    .map((part) => `'${part.replace(/'/gu, '\'\'')}'`)
    .join(' || char(59) || ');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
