-- 登录统计取数清单（loginbase 1.4.0+）
-- 口径以 docs/stats-design.md 为准；执行方式与常见误读见 queries/README.md。
--
-- 约定：
--   · 时间列 at 存 UTC 毫秒，按 Asia/Shanghai 分天故一律 +28800 秒
--   · 时间窗写成 strftime('%s','now','-N days')*1000，改 N 即改窗口
--   · 本文件按节组织，人肉取数时复制单节内容执行即可


-- ============================================================
-- 00 · 哨兵：一条命令扫掉所有该警惕的东西（近 1 天）
--
-- 分两档看，别混为一谈：
--   A·出现即查 —— 故障。非零就是有东西坏了，逐条追。
--   B·看量级   —— 不是故障，是**用户在撞墙**。少量正常，成堆就是产品问题。
--
-- B 档是 2026-08-17 首次面对真流量后补的：那天 link_conflict 发生了 14 次，
-- 而当时的哨兵只盯故障，返回空。覆盖面只能被真实数据检验出来，纸上想不全。
-- ============================================================
SELECT CASE WHEN event = 'code_send_failed'
              OR (event='refresh'        AND outcome IN ('reuse_revoked','guardrail_revoked'))
              OR (event='oauth_callback' AND outcome IN ('oauth_failed','no_email','internal'))
              OR (event='code_verify'    AND outcome = 'internal')
            THEN 'A·出现即查' ELSE 'B·看量级' END AS severity,
       event, outcome, COUNT(*) AS n
FROM auth_events
WHERE at >= (strftime('%s','now','-1 day') * 1000)
  AND (
    -- A 档：故障
       event = 'code_send_failed'                                                  -- 发不出邮件，邮箱轨整条断
    OR (event = 'refresh'        AND outcome IN ('reuse_revoked','guardrail_revoked')) -- 杀链；guardrail 非零 = 客户端单飞纪律破了
    OR (event = 'oauth_callback' AND outcome IN ('oauth_failed','no_email','internal')) -- GitHub 侧故障 / 用户被挡门外 / 消费方 bug
    OR (event = 'code_verify'    AND outcome = 'internal')                          -- onVerified 抛错
    -- B 档：用户撞墙
    OR (event = 'oauth_callback' AND outcome = 'link_conflict')                     -- 绑定被业务规则拒绝，reason 在 meta 里
    OR  event = 'rate_limited'                                                      -- cooldown 层无害；email/ip 层 = 真发不出码
    OR (event = 'oauth_exchange' AND outcome = 'invalid_otc')                       -- otc 60 秒不够用 / 回跳绕了远路
  )
GROUP BY severity, event, outcome
ORDER BY severity, n DESC;


-- ============================================================
-- 01 · 总览：近 14 天按天（一眼看全貌）
-- ============================================================
SELECT date(at/1000 + 28800, 'unixepoch')                        AS day_cst,
       SUM(event = 'login')                                      AS logins,
       COUNT(DISTINCT CASE WHEN event='login' THEN user_id END)  AS users,
       SUM(event = 'login' AND is_new_user = 1)                  AS new_users,
       SUM(event = 'code_sent')                                  AS code_sent,
       SUM(event = 'code_verify' AND outcome = 'ok')             AS code_ok,
       SUM(event = 'oauth_start' AND outcome = 'ok')             AS oa_start,
       SUM(event = 'oauth_callback' AND outcome = 'issued')      AS oa_issued,
       SUM(event = 'oauth_exchange' AND outcome = 'ok')          AS oa_done,
       SUM(event = 'code_send_failed')                           AS send_fail
FROM auth_events
WHERE at >= (strftime('%s','now','-14 days') * 1000)
GROUP BY day_cst
ORDER BY day_cst DESC;


-- ============================================================
-- A2 / A3 · 日登录独立用户、日新增用户（近 30 天）
-- ============================================================
SELECT date(at/1000 + 28800, 'unixepoch') AS day_cst,
       COUNT(*)                           AS logins,      -- A1
       COUNT(DISTINCT user_id)            AS users,       -- A2 ★
       SUM(is_new_user = 1)               AS new_users,   -- A3 ★
       ROUND(100.0 * SUM(is_new_user = 1) / NULLIF(COUNT(*),0), 1) AS new_pct
FROM auth_events
WHERE event = 'login'
GROUP BY day_cst
ORDER BY day_cst DESC
LIMIT 30;


-- ============================================================
-- B1 · 登录方式占比（近 30 天）
-- ============================================================
SELECT provider,
       COUNT(*)                AS logins,
       COUNT(DISTINCT user_id) AS users,
       SUM(is_new_user = 1)    AS new_users
FROM auth_events
WHERE event = 'login'
  AND at >= (strftime('%s','now','-30 days') * 1000)
GROUP BY provider
ORDER BY logins DESC;


-- ============================================================
-- C2 / C3 · 邮箱轨转化与失败分因（近 7 天）
-- C3 只有三类：invalid_code(码错) / code_not_found(过期·已焚·没发过·已用过，
-- KV 层不可再分) / too_many_attempts(连错 5 次即焚)
-- ============================================================
SELECT SUM(event = 'code_sent')                       AS sent,
       SUM(event='code_verify' AND outcome='ok')      AS verified,
       ROUND(100.0 * SUM(event='code_verify' AND outcome='ok')
             / NULLIF(SUM(event='code_sent'),0), 1)   AS convert_pct   -- C2 ★
FROM auth_events
WHERE at >= (strftime('%s','now','-7 days') * 1000);

SELECT outcome, COUNT(*) AS n                                          -- C3 ★
FROM auth_events
WHERE event = 'code_verify'
  AND at >= (strftime('%s','now','-7 days') * 1000)
GROUP BY outcome
ORDER BY n DESC;


-- ============================================================
-- D4 · OAuth ①→③ 流失率（近 7 天）
-- 掉的这批 = 授权页取消 + 打不开 + 链路差的合计，服务端分不出原因
-- ============================================================
SELECT SUM(event='oauth_start' AND outcome='ok')  AS started,
       SUM(event='oauth_callback')                AS arrived,
       ROUND(100.0 * (1 - 1.0 * SUM(event='oauth_callback')
             / NULLIF(SUM(event='oauth_start' AND outcome='ok'),0)), 1) AS drop_pct  -- D4 ★
FROM auth_events
WHERE at >= (strftime('%s','now','-7 days') * 1000);


-- ============================================================
-- D11 · 回跳丢失（近 7 天）——本盘最值钱的一个数
-- 按 flow_id 精确配对，不是两个计数相减
-- ============================================================
SELECT COUNT(*)                                    AS issued,
       SUM(x.flow_id IS NOT NULL)                  AS exchanged,
       COUNT(*) - SUM(x.flow_id IS NOT NULL)       AS lost,
       ROUND(100.0 * (COUNT(*) - SUM(x.flow_id IS NOT NULL))
             / NULLIF(COUNT(*),0), 1)              AS lost_pct        -- D11 ★
FROM auth_events i
LEFT JOIN auth_events x
       ON x.flow_id = i.flow_id
      AND x.event   = 'oauth_exchange'
      AND x.outcome = 'ok'
WHERE i.event = 'oauth_callback'
  AND i.outcome = 'issued'
  AND i.at >= (strftime('%s','now','-7 days') * 1000);


-- ============================================================
-- D13 / D12 · 回跳耗时与一次性码失效（otc TTL = 60 秒）
-- over_45s 是预警线：还没开始失败，但已经贴着墙走
-- ============================================================
SELECT COUNT(*)                        AS paired,
       MIN(x.at - i.at)                AS min_ms,
       ROUND(AVG(x.at - i.at))         AS avg_ms,
       MAX(x.at - i.at)                AS max_ms,
       SUM((x.at - i.at) > 45000)      AS over_45s
FROM auth_events i
JOIN auth_events x
  ON x.flow_id = i.flow_id AND x.event='oauth_exchange' AND x.outcome='ok'
WHERE i.event='oauth_callback' AND i.outcome='issued'
  AND i.at >= (strftime('%s','now','-7 days') * 1000);

SELECT COUNT(*) AS invalid_otc                                          -- D12
FROM auth_events
WHERE event='oauth_exchange' AND outcome='invalid_otc'
  AND at >= (strftime('%s','now','-7 days') * 1000);


-- ============================================================
-- F2 · 会话续期健康与救活率（近 7 天）
-- guardrail 非零 = 客户端并发刷新、单飞纪律破了，去查是哪个版本
-- ============================================================
SELECT SUM(outcome='ok')                AS ok,
       SUM(outcome='rescued')           AS rescued,
       SUM(outcome='reuse_revoked')     AS reuse_revoked,
       SUM(outcome='guardrail_revoked') AS guardrail_revoked,
       SUM(outcome='invalid')           AS invalid,
       ROUND(100.0 * SUM(outcome='rescued')
             / NULLIF(SUM(outcome IN ('ok','rescued')),0), 2) AS rescue_pct  -- F2 ★
FROM auth_events
WHERE event = 'refresh'
  AND at >= (strftime('%s','now','-7 days') * 1000);


-- ============================================================
-- G1 · 发信失败与错误串（近 30 天）
-- meta 里是 Resend 的原始错误串，HTTP 码在其中
-- ============================================================
SELECT COUNT(*) AS n, meta
FROM auth_events
WHERE event = 'code_send_failed'
  AND at >= (strftime('%s','now','-30 days') * 1000)
GROUP BY meta
ORDER BY n DESC
LIMIT 10;


-- ============================================================
-- K3 · 用户归属国（累计，按首次登录时的国家给用户打标）
-- 不受漫游影响；v1 不清理数据，故「最早」就是真的最早
-- ============================================================
SELECT first_country, COUNT(*) AS users                                 -- K3 ★
FROM (
  SELECT user_id,
         country AS first_country,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY at) AS rn
  FROM auth_events
  WHERE event = 'login' AND user_id IS NOT NULL
)
WHERE rn = 1
GROUP BY first_country
ORDER BY users DESC;


-- ============================================================
-- K9 · 网络画像：国家 × ASN × 边缘节点（近 30 天登录）
-- 云厂商 ASN ≈ 代理出口；colo 与 country 不一致 = 流量绕道
-- ============================================================
SELECT country, asn, colo, COUNT(*) AS logins, COUNT(DISTINCT user_id) AS users
FROM auth_events
WHERE event = 'login'
  AND at >= (strftime('%s','now','-30 days') * 1000)
GROUP BY country, asn, colo
ORDER BY logins DESC
LIMIT 20;


-- ============================================================
-- H1 · 限流命中分层（近 7 天）
-- cooldown = 用户自己手快（无害）；email / ip = 真被窗口挡住，发不出码
-- ============================================================
SELECT outcome AS layer, COUNT(*) AS n
FROM auth_events
WHERE event = 'rate_limited'
  AND at >= (strftime('%s','now','-7 days') * 1000)
GROUP BY layer
ORDER BY n DESC;


-- ============================================================
-- 附 · 原始事件抽样（排查个案用）
-- 拿到某次可疑流程的 flow_id 后，用第二条看它完整的一生
-- ============================================================
SELECT id, datetime(at/1000 + 28800,'unixepoch') AS ts_cst,
       event, outcome, provider, user_id, flow_id, country, asn, meta
FROM auth_events
ORDER BY id DESC
LIMIT 50;

SELECT datetime(at/1000 + 28800,'unixepoch') AS ts_cst, event, outcome, meta
FROM auth_events
WHERE flow_id = 'PUT-FLOW-ID-HERE'
ORDER BY at;
