PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL DEFAULT '#99CC66',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  username_lower TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  bio TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content_md TEXT NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS likes (
  user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  type TEXT NOT NULL,
  post_id TEXT,
  reply_id TEXT,
  text_preview TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_board_activity ON posts(board_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_activity ON posts(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_replies_post_created ON replies(post_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_search ON users(username_lower, role, status);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('forum_title', 'Hi~是这！', unixepoch()),
  ('forum_description', '一个运行在 Cloudflare Workers 上的微型论坛。', unixepoch()),
  ('forum_keywords', 'cloudflare,worker,d1,bbs', unixepoch()),
  ('site_notice', '欢迎来到这个轻量讨论版。', unixepoch()),
  ('allow_registration', 'true', unixepoch()),
  ('page_size_posts', '12', unixepoch()),
  ('page_size_replies', '15', unixepoch());

INSERT OR IGNORE INTO boards (id, slug, name, icon, description, accent, sort_order, is_visible, created_at, updated_at) VALUES
  ('sp', 'sp', '灌水', '水', '聊天、日常、随手发。', '#69c6dc', 1, 1, unixepoch(), unixepoch()),
  ('ps', 'ps', '创造', '创', '原创作品、项目记录、灵感草稿。', '#ffb65d', 2, 1, unixepoch(), unixepoch()),
  ('ht', 'ht', '转载', '转', '收藏、摘录、参考资料。', '#65d8a6', 3, 1, unixepoch(), unixepoch()),
  ('fl', 'fl', '杂务', '务', '提问、求助、杂谈。', '#ff7f7f', 4, 1, unixepoch(), unixepoch()),
  ('sa', 'sa', '音乐', '音', '音乐、声音、氛围分享。', '#ff5b5b', 5, 1, unixepoch(), unixepoch()),
  ('cs', 'cs', '站务', '站', '公告、建议、反馈。', '#7c90ff', 6, 1, unixepoch(), unixepoch());
