ALTER TABLE users ADD COLUMN deleted_at INTEGER;
ALTER TABLE users ADD COLUMN status_before_delete TEXT;

ALTER TABLE posts ADD COLUMN deleted_at INTEGER;
ALTER TABLE replies ADD COLUMN deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_status_created ON users(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_deleted_at ON posts(is_deleted, deleted_at DESC, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_replies_deleted_at ON replies(is_deleted, deleted_at DESC, created_at DESC);
