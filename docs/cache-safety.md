# 部署约束：所在 zone 的缓存规则

loginbase 的 GitHub 登录在服务端用用户的 access token 请求 `https://api.github.com/user` 与 `https://api.github.com/user/emails`（`src/plugins/github.ts`）。这两次请求是 Worker 子请求，URL 对所有用户相同，身份只在 `Authorization` 头里。**它们会继承 Worker 所在 zone 的缓存规则。** zone 上若存在让这类响应可缓存的规则，第一个用户的资料会被按 URL 存下来，之后在同一缓存层登录的任何人都拿到他的资料、被解析成他的账户，并把自己的 GitHub token 存进他名下。这不是理论风险，2026-08 在一个消费方的生产环境实际发生过。

## 机制

来自 Cloudflare 官方文档，逐字：

- Worker 的 fetch「reads through its own zone's cache, even if the URL is for a non-Cloudflare site. Cache settings on fetch automatically apply caching rules based on your Cloudflare settings.」（Workers · How the Cache works）
- Cache Rules 的 Edge TTL 选项之一：「Ignore cache-control header and use this TTL: Completely ignore any cache-control header on the response and instead cache the response for a duration specified」（Cache Rules settings）
- 「By default, Cloudflare does not consider vary values in caching decisions.」（Origin Cache Control）

GitHub 对 `/user` 的响应带 `Cache-Control: private` 与 `Vary: Authorization`，在 Cloudflare 默认行为下不会被存。但一条「所有请求 + Eligible for cache + Ignore cache-control」的规则会同时越过这三道：`private` 被忽略，`Vary` 默认不参与，缓存键只有 URL。Cloudflare 一键模板「Cache everything」就是这个形态。

Tiered Cache 开启时，缓存条目在上层节点被多个数据中心共享，串号不限于同一个 colo。

## 部署方要做的

1. **Worker 所在 zone 不要有任何使第三方子请求可缓存的 Cache Rules 或 Page Rules。** 最简单、也是唯一容易核对的口径是零缓存规则。为官网性能配的「Cache everything」类规则作用域是整个 zone，会一并覆盖挂在同 zone 子域上的 API Worker。
2. 规则处于 disabled 状态不算达标，一键即可恢复；要删除。
3. 若 zone 必须保留缓存规则，规则的匹配条件要显式限定在需要缓存的主机名，并在 Vary 设置里把默认动作设为 bypass，让 `Vary: Authorization` 恢复作用。这是次选，且需要在自己的 zone 上验证子请求确实不再命中。
4. 把「zone 零缓存规则」写进运维约定，并加一道 push 触发的检查：读取 zone 的 `http_request_cache_settings` 规则集，非空即红。鉴权失败要与「零规则」区分开，不能因为读不到就放行。

## 如何判断自己有没有中招

- `auth_events` 里串号的登录与正常登录一模一样，没有任何可直接查询的标记。
- 可用的启发式判据：同一 `user_id` 在两小时内相邻两次 `oauth_callback`，而 `country` 或 `colo` 不同；或出现「登录 → 立即 `session_revoked` → 再登录」的形态。
- 受害账户的 `gh_token_updated_at` 会等于入侵者登录的时间；账户主人的 App 会拿着别人的 GitHub token 访问 GitHub。

## 库侧当前状态（1.8.0）

- 身份来自 `POST /applications/{client_id}/token`（GitHub 的 token introspection，Basic 认证用 client_id 与 client_secret）。POST 不受缓存规则影响；它同时证明这枚 token 属于本 App，失败回跳 `token_check_failed`。
- 展示字段来自 `GET /user/{id}`，URL 含耐久数字 id，被缓存也只命中本人；取不到不影响登录。
- `GET /user/emails` 仍是固定 URL 加用户凭据的 GET，不带缓存控制。它只影响锚点为邮箱的建号与合并，在零缓存规则的 zone 上受 GitHub 响应头与 Cloudflare 默认行为保护。库本身不对 zone 配置做任何检测。
