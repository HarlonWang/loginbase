-- loginbase 会话表（Tono-Server migrations 0002_create_sessions + 0004_add_session_rescue 的合并端态）。
-- id 即 refresh token 的 SHA-256 hex；user_id 由业务侧提供，库只存不读。
-- rescued_at 非 NULL 表示该行由救活逻辑（从存活后继再轮换）产生，
-- 用于统计同一 family 在时间窗口内的救活次数，超限即按真重用撤销整链。
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  family_id       TEXT NOT NULL,
  expires_at      INTEGER,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL,
  user_agent      TEXT,
  ip              TEXT,
  revoked_at      INTEGER,
  replaced_by_id  TEXT,
  rescued_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_family_id ON sessions(family_id);
CREATE INDEX IF NOT EXISTS idx_sessions_rescued   ON sessions(family_id, rescued_at);
