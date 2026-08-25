# loginbase 协议契约

> **本文件是 API 契约的唯一权威**，只住服务端仓——客户端仓 `HarlonWang/loginbase-kt` 只链接、不留副本。协议变更必须与服务端实现同 commit，并在客户端仓开跟进 issue、客户端版本落地前不关（2026-08-13 分仓后的纪律，见 CLAUDE.md 铁律与 design.md）。
>
> 协议版本以**服务端包版本**表达：本文对应 `loginbase@1.6.0`。客户端仓自有版本线（`0.1.0` 起），在其 README 声明对齐到哪个服务端版本，两端版本号不追求相等。
>
> 结构与决策背景见 [server-design.md](server-design.md)；本文只记 wire 层事实。

## 通用约定

- 所有端点挂在消费方选定的 `basePath` 下（默认 `/auth`，下文省略前缀）。
- 请求/响应体均为 JSON（`Content-Type: application/json`）。
- 错误响应统一形状：`{ "error": string, ...附加字段 }`，HTTP 状态码与 error 码一一对应。
- 鉴权端点使用 `Authorization: Bearer {accessToken}`。
- 客户端 IP 取 `CF-Connecting-IP`，UA 取 `User-Agent`（会话元数据与 IP 限流用）。
- email 归一化：`trim().toLowerCase()`，格式校验 `/^\S+@\S+\.\S+$/`；unicode 大小写折叠与 `+` 别名**不处理**。

## 令牌模型

| | access token | refresh token |
|---|---|---|
| 形态 | JWT（HS256），载荷 `sub`=userId、`sid`=sessionId、`iat`、`exp` | 32 字节 CSPRNG 的 base64url（无填充，43 字符） |
| TTL | 默认 3600s（服务端可配 `jwt.accessTtlSeconds`） | 默认不过期（服务端可配 `session.refreshTtlMs`，滑动窗口：每次轮换重新起算） |
| 吊销 | 不可吊销，短命封顶（吊销延迟 ≤ TTL） | 可吊销；服务端只存 SHA-256 |
| 使用 | 每个业务请求 `Authorization: Bearer` | 仅 `POST /refresh` |

**轮换语义**：每次 refresh 必轮换（旧 token 作废、发新对，同 family）。已作废 token 再次提交时走救活判定：直接后继未被使用 → 判丢回执诚实重试，从后继再轮换发**全新对**（旧后继同时作废）；后继已被使用 → 判真重用，**撤销整条 family**；同 family 1h 内救活满 3 次 → 按盗用撤销整链。客户端应实现**单飞 refresh**（并发刷新会消耗救活配额）。

## 端点

### POST /code/send

请求：`{ "email": string, "locale"?: string }`

| 结果 | 状态码 | 响应 |
|---|---|---|
| 成功（无论账号是否存在，防枚举） | 200 | `{ "cooldownSeconds": 60 }` |
| 邮箱格式非法 | 400 | `{ "error": "invalid_email" }` |
| 限流命中 | 429 | `{ "error": "too_many_requests", "retryAfterSeconds": number }` |
| 邮件信道失败 | 500 | `{ "error": "internal" }` |

限流三层（先到先拒，`retryAfterSeconds` 为对应窗口秒数）：单邮箱 60s 冷却 → 单邮箱 3 次/600s → 单 IP 10 次/3600s。发送失败不消耗任何限流额度。

**`locale`（1.3.0 起，可选）**——本次验证码邮件的语言，BCP 47 标签（如 `zh-Hans-CN`、`en-GB`）。取值应为**用户在 App 里看到的界面语言**，而非系统首选语言（两者可能不同）。

- **永不因 locale 报错**：不传、传空、传非字符串、传服务端不支持的语言，一律**静默回落**到服务端配置的兜底语言，**错误码表不新增任何一条**——客户端无需为此写任何错误处理分支。
- 服务端归一化：`_`→`-`、转小写、截断 64 字符；匹配按 RFC 4647 Lookup **逐级砍子标签**（`zh-Hans-CN` → `zh-Hans` → `zh`）。故客户端传 Android `Locale.toString()` 的 `zh_CN` 也能命中，但**应传 `toLanguageTag()` 的标准形态**。
- **取不到语言时应省略该字段，而不是传 `und`**——服务端把 `und`/`und-*` 与未传同等对待（两者结果一致），但客户端省略字段能让服务端事件区分「没传」与「传了但不支持」，是排查客户端链路故障的唯一信号。
- 支持哪些语言由**各消费方的服务端配置**决定（库内置 `en`/`zh`，消费方可覆盖或新增），不是协议层的固定枚举——客户端不应硬编码支持集，传自己的语言即可。

### POST /code/verify

请求：`{ "email": string, "code": string }`

| 结果 | 状态码 | 响应 |
|---|---|---|
| 成功 | 200 | `{ "accessToken": string, "refreshToken": string, "isNewUser"?: boolean, "user"?: object }` |
| 无有效验证码（未发过/已过期/已焚毁） | 400 | `{ "error": "code_expired" }` |
| 验证码不匹配（剩余尝试内） | 400 | `{ "error": "invalid_code" }` |
| 第 5 次错误（码即焚） | 429 | `{ "error": "too_many_attempts" }` |
| 业务侧 onVerified 失败 | 500 | `{ "error": "internal" }`（此时码已焚，需重新发码） |

- 验证码 6 位数字、600s 有效、验证成功即焚、累计 5 次错误即焚。
- `isNewUser` / `user` 由消费方 App 的 `onVerified` 钩子返回值**原样透传**，形状归 App 所有（Tono 为 `{id, email, isPro, proExpiresAt, createdAt}`）；协议只保证 `accessToken`/`refreshToken` 两个字段。

### 演示账号（服务端配置 `demoAccount` 后启用，默认不存在）

给应用商店审核用（Play 与 App Store 共用同一个，故邮箱别取带商店名的名字）。**wire 零变更、客户端零改动**——它看到的就是一次普通的邮箱验证码登录，演示码与真码同形（6 位数字）。

命中配置邮箱（比对 `trim().toLowerCase()`，大小写不敏感）时，与常规路径的**全部差别只有 `/code/send` 内的两点**：验证码不随机生成、恒为配置的固定值；不真实发信（演示邮箱无人收件）。其余一切照旧——send 的三层限流、KV 存码（600s TTL）、verify 的读码/比对/错 5 次即焚/成功即焚/建会话，全部与常规账号共用同一段代码，**不存在鉴权旁路**。

审核员的使用方式与真实用户完全相同：输邮箱 → 点发送 → 输提前告知的固定码。每次 send 都重新写入同一个码，凭据因此**随时可用、可重复使用**；防暴破与常规账号同一套防线——固定码仅在 send 后 600s 内有效、错 5 次即焚、send 受限流约束（穷举一轮至多 5 猜且要重发）。对外表现（响应体、错误码、限流）与任意真实账号逐字节一致，唯一残余差别是 send 不调用发信服务的时序侧信道，判断为可接受。

相关统计事件（send 与 verify 两端，含撞限流的 `rate_limited`）带 `meta.demo = true`，便于把审核流量从登录漏斗剔除。**未配置 `demoAccount` 时该路径完全不存在**，同一组邮箱和码走常规路径、换不到会话；**配错的码（trim 后非 6 位数字）同样视同未配置**——verify 会把缺失的 `code` 字段读成空串，空演示码等于免凭据登录，故宁可让演示账号登不进。

### POST /refresh

请求：`{ "refreshToken": string }`

| 结果 | 状态码 | 响应 |
|---|---|---|
| 成功（含救活） | 200 | `{ "accessToken": string, "refreshToken": string }` |
| 失败 | 401 | `{ "error": "invalid_refresh_token", "reason": string }` |

`reason` 枚举（客户端据此归因，均应视为登录态终结、引导重新登录——除非实现了与救活配合的重试）：

| reason | 语义 |
|---|---|
| `missing_token` | 请求体缺 refreshToken |
| `session_not_found` | token 无对应会话（伪造/已清理） |
| `session_revoked` | 重用检测触发（真重用或救活护栏超限），整 family 已撤销 |
| `session_expired` | 会话已过 `refreshTtlMs`（若服务端配置） |
| `rotate_failed` | 轮换内部失败（罕见） |

### DELETE /sessions

Bearer 鉴权。吊销当前会话（access token 的 `sid`）。成功 `204`；无/坏 token `401`。

### DELETE /sessions/all

Bearer 鉴权。吊销该用户全部会话。成功 `204`；无/坏 token `401`。

## GitHub OAuth（可选插件，服务端配置 `socials.github` 后启用）

设计目标：**token 永不进 URL**（移动端 deepLink 回跳链路），以一次性授权码（otc）中转。未配置该插件时，以下端点返回 `404 { "error": "not_configured" }`。

### GET /oauth/github/start?redirect={deepLink}

校验 `redirect` 命中服务端白名单（`allowedRedirects`，结构化匹配：scheme + host 精确一致、path 允许前缀扩展，防开放重定向）→ 生成 `state`（32B random，KV 存 600s、单次使用）→ `302` 跳转 GitHub authorize（scope 取服务端配置 `socials.github.scope`，默认 `user:email`）。

| 失败 | 状态码 | 响应 |
|---|---|---|
| redirect 缺失或不在白名单 | 400 | `{ "error": "invalid_redirect" }` |

### POST /oauth/github/link/start（1.2.0 起）

**已登录用户绑定第二身份**。Bearer 鉴权；请求 `{ "redirect": string }`。

| 结果 | 状态码 | 响应 |
|---|---|---|
| 成功 | 200 | `{ "authorizeUrl": string }` |
| 无/坏 token | 401 | `{ "error": "Unauthorized" }` / `{ "error": "Invalid token" }` |
| redirect 缺失或不在白名单 | 400 | `{ "error": "invalid_redirect" }` |
| 未配置 `socials.github` 或未提供 `onLinked` | 404 | `{ "error": "not_configured" }` |

**为什么是 POST 而非 302**：浏览器导航带不了 `Authorization` 头，故不能像 login 的 `start` 那样直接跳转——客户端先换取 `authorizeUrl`，再自行用系统浏览器打开。服务端把当前 `userId` 写进 `state` 的 KV 载荷（客户端不可见、不可传入）。

### GET /oauth/github/callback?code={code}&state={state}

GitHub 回调，**login 与 link 共用**（GitHub OAuth App 的回调地址注册在 GitHub 侧，多一个即多一处配置漂移）。验证并焚毁 `state` → server-side 换 token（`client_secret` 参与，客户端不可见）→ 取 GitHub 用户身份与已验证邮箱 → 按 `state` 载荷的 `mode` 分流：

**login 分支**（`mode` 缺省）：`onVerified({provider:"github", providerUserId, email, verifiedEmails, providerProfile, providerAccessToken})` → 建会话 → 生成 `otc`（32B random，KV 存 60s、单次使用）→ `302 {redirect}?otc={otc}`。

**link 分支**（`mode === "link"`，1.2.0 起）：`onLinked({userId, ...同上})` → **不建会话、不发 token**（用户本来就登录着，故也不需要 otc 中转）→ `302 {redirect}?linked=github`。

| 失败 | 行为 |
|---|---|
| state 缺失/无效/已使用 | `400 { "error": "invalid_state" }`（redirect 未知，无法回跳） |
| GitHub 回 `?error=`（用户拒绝授权等，无 `code`） | `302 {redirect}?error={error}`（典型 `access_denied`）；`error` 不匹配 `[A-Za-z0-9_]{1,64}` 或缺省时回落 `no_code`。**state 有效才走这里**，否则同上一行 |
| GitHub 换码或取用户失败 | `302 {redirect}?error=oauth_failed` |
| 无 verified 邮箱 | login：`302 {redirect}?error=oauth_no_email`；**link 分支不失败**——userId 已定，email 只是附加信息 |
| onVerified / onLinked 抛错 | `302 {redirect}?error=internal` |
| onLinked 返回 `{ok:false, reason}` | `302 {redirect}?error={reason}`（App 自定，典型 `already_linked`）；`reason` 不匹配 `[A-Za-z0-9_]{1,64}` 时回落 `internal` |

### POST /oauth/exchange

请求：`{ "otc": string }`

| 结果 | 状态码 | 响应 |
|---|---|---|
| 成功（otc 即焚） | 200 | `{ "accessToken": string, "refreshToken": string, "isNewUser"?: boolean, "user"?: object }`（与 verify 同构） |
| otc 无效/已使用/过期 | 400 | `{ "error": "invalid_otc" }` |

客户端流程：系统浏览器打开 `start` → GitHub 授权 → deepLink 收到 `otc` → 调 `exchange` 换 token 对。`otc` 有效期 60s、单次使用，泄露进系统日志也只有一次兑换窗口。

## 错误码总表

| error | 端点 | 状态码 |
|---|---|---|
| `invalid_email` | code/send | 400 |
| `too_many_requests` | code/send | 429 |
| `code_expired` / `invalid_code` | code/verify | 400 |
| `too_many_attempts` | code/verify | 429 |
| `invalid_refresh_token` (+`reason`) | refresh | 401 |
| `invalid_redirect` | oauth/github/start、oauth/github/link/start | 400 |
| `invalid_state` | oauth/github/callback | 400 |
| `invalid_otc` | oauth/exchange | 400 |
| `not_configured` | oauth/*（插件未配置；link 端点还需 `onLinked` 已提供） | 404 |
| `already_linked` 等 | oauth/github/callback 的 link 分支回跳（**App 自定**，非库内枚举） | 302 |
| `internal` | code/send、code/verify、oauth | 500 |
| `Unauthorized` / `Invalid token` | Bearer 鉴权端点 | 401 |

## 服务端 KV 键位（实现事实，非客户端契约）

| 键 | TTL | 用途 |
|---|---|---|
| `code:{email}` | 600s | 验证码 `{code, attempts, issuedAt}` |
| `cooldown:{email}` | 60s | 发码冷却 |
| `rl:email:{email}` / `rl:ip:{ip}` | 600s / 3600s | 发码计数 |
| `oauth:state:{state}` | 600s | OAuth state（单次） |
| `oauth:otc:{otc}` | 60s | 一次性授权码载荷（单次） |

## 版本历史

- **1.6.0**（2026-08）：GitHub callback 收到 `?error=`（无 `code`）时改为 **302 回跳** `{redirect}?error={error}`（典型 `access_denied`，字符集不合法或缺省时回落 `no_code`），并以该值作为 `oauth_callback` 的 outcome。此前它与「state 读不出」合并在一个分支，一律 `400 invalid_state`——把「用户在授权页点了拒绝」记成了 state 无效，且用户被留在浏览器的错误页上收不到回跳。**wire 向后兼容**：新增的是一种已存在形态的回跳（`?error=` 早就是 callback 的失败约定），不认识 `access_denied` 的老客户端按既有未知 error 分支处理。**state 无效时的 400 不变**——那种情况回跳地址不可信。

- **1.5.0**（2026-08）：新增**可选**服务端配置 `demoAccount`，给应用商店审核用的固定邮箱 + 固定验证码（见上方「演示账号」）。**wire 零变更、客户端零改动**；实现上唯一分叉在 `/code/send`（码为定值、不发信），verify 与建会话全走常规路径，无鉴权旁路。**未配置时该路径完全不存在。**动因：无密码登录交不出商店要的「随时可用、可重复使用」凭据，Play 的「登录详细信息」表单尤其不接受「部分功能受限但不提供凭据」，TrendingAI 1.4.1 于 2026-08-22 因此被拒；Play 与 App Store Connect 的要求一致，故一个演示账号跨商店共用。

- **1.3.0**（2026-08）：`POST /code/send` 新增**可选** `locale`（BCP 47），决定本次验证码邮件的语言；**错误码零新增**——未知/非法值静默回落服务端兜底语言，客户端无新增错误分支。**wire 向后兼容**：不传即为 1.2.0 行为；老服务端收到该字段会忽略它（请求体逐字段读取，无严格校验），故客户端可先于服务端发布。⚠️ **同版本含配置 API 的 BREAKING 变更**（不影响 wire，故未推 major）：`email.locale` 更名为 `email.fallbackLocale`（旧键不再识别）、`email.templates` 由整体覆盖改为按 locale 分表且模板签名改为 `(ctx) => string`——**消费方升级依赖时必须同步改配置**，详见 server-design.md「语言与模板体系」。

- **1.2.0**（2026-08）：新增 `POST /oauth/github/link/start` 与 callback 的 **link 分支**（已登录用户绑定第二身份，`onLinked` 钩子，不建会话不发 token）；GitHub authorize 的 `scope` 改为服务端可配（默认 `user:email`）；`onVerified`/`onLinked` 的 identity 新增 `providerAccessToken`（库只透传不存储）与 `verifiedEmails`（全部已验证邮箱，归一化小写）。**向后兼容**：1.1.0 期间写入的 state 载荷无 `mode`，新代码按 login 分支处理，滚动升级期在飞的授权不受影响。

- **1.0.0**（2026-08）：初版定稿。邮箱验证码 + 会话管理端点承接 Tono-Server 生产实现（wire 不变）；新增 `user`/`isNewUser` 归属说明（onVerified 透传）、github-oauth 三端点、`session_expired` 语义（refreshTtlMs 可配后生效）。
