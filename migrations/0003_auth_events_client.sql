-- 客户端标识两列（loginbase 1.9.0 起，协议见 docs/protocol.md「客户端标识」节）。
-- 值只来自客户端的结构化头 / start 参数，服务端不从 UA 解析（CLAUDE.md 铁律）；
-- 老客户端不带即为 NULL，读数时单独成「未上报世代」桶（docs/stats-design.md 公共口径 6）。
--
-- ⚠️ 本迁移非幂等：SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，重复执行报 duplicate column。
-- 恢复步骤：先 `PRAGMA table_info(auth_events)` 确认两列已在，再往 d1_migrations 手动补记本文件名。
-- 未执行本迁移时统计照常落库（库内回退到不带这两列的 INSERT，并告警一次 stats_schema_outdated）。
ALTER TABLE auth_events ADD COLUMN client_version  TEXT;
ALTER TABLE auth_events ADD COLUMN client_platform TEXT;
