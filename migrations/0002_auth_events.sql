-- 登录统计事件表（docs/stats-design.md v1）。归库所有，与 sessions 同库。
-- 升级到 1.4.0 后必须执行本迁移：统计模块默认开启，表不存在时写入会失败
-- （登录不受影响，会有一次 stats_unavailable 告警事件）。
CREATE TABLE IF NOT EXISTS auth_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,               -- UTC 毫秒
  event       TEXT    NOT NULL,
  outcome     TEXT,
  provider    TEXT,                           -- email | github
  user_id     TEXT,
  flow_id     TEXT,                           -- 串联 OAuth 三段，非凭证
  is_new_user INTEGER,                        -- 0 | 1 | NULL
  country     TEXT,                           -- request.cf.country，缺失落 'unknown'
  source      TEXT NOT NULL DEFAULT 'server', -- server | client（client 留给二期）
  meta        TEXT                            -- JSON：familyId、locale、错误串等低频字段
);
CREATE INDEX IF NOT EXISTS idx_auth_events_at       ON auth_events(at);
CREATE INDEX IF NOT EXISTS idx_auth_events_event_at ON auth_events(event, at);
CREATE INDEX IF NOT EXISTS idx_auth_events_flow     ON auth_events(flow_id);
