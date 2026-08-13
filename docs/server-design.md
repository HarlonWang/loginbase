# loginbase 服务端技术方案

> 2026-08-12 定稿。承接 [design.md](design.md) 的路线与边界，本文给出 TS 服务端库的完整技术设计：公共 API、协议草案、会话模型、数据模型、包结构与平移策略。母本是 Tono-Server `src/auth/`（6 模块 661 行，生产验证），本文描述的是**钩子化后的端态**（落地第 2 步完成时的形态），第 1 步平移的中间态差异见 [平移策略](#平移策略第-1-步--端态)。协议的字节级细节（字段、错误码、示例）在实现时落入 `protocol.md`，本文只锁结构与决策。

## 范围与非目标

- **做**：邮箱验证码（发码/验码）、会话生命周期（签发/刷新/轮换/重用检测/救活/吊销）、业务接口鉴权（middleware/verifyToken）、github-oauth 可选插件。
- **不做**：用户档案与 `/me` 类端点（用户语义经 `onVerified` 还给 App，库不知道 users 表长什么样）、权益/订阅、跨 App 账号、UI、**第三方 provider 凭据的存储与再分发**（OAuth token 透传给 `onVerified` 即止，1.2.0 起）。
- 运行底座只承诺 Cloudflare Workers（D1 + KV binding 是唯一平台锁定，见 design.md 技术选型）。

## 公共 API

```ts
import { createLogin } from "loginbase";

const login = createLogin<Env>((env) => ({
  db: env.DB,
  kv: env.EMAIL_CODES,
  jwt: { secret: env.JWT_SECRET, accessTtlSeconds: 3600 },
  email: {
    resendApiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM_ADDRESS,
    brand: "Tono",                            // 进邮件标题/正文
    locale: "en",                             // 内置 zh/en 模板（第 2 步）
    templates: { subject, html, text },       // 可选整体覆盖
  },
  session: { refreshTtlMs: null },            // null = refresh 不过期（Tono 现状）
  onVerified: async (identity) => ({ userId, isNewUser, user }),
  onEvent: (e) => console.log(JSON.stringify(e)),   // 默认即此实现
  socials: { github: { clientId, clientSecret } },  // 可选插件（第 2 步）
}), { basePath: "/auth" });  // basePath 为静态选项，默认 /auth

// 出口
login.app          // Hono 实例（已含 basePath），Hono 消费方 app.route("/", login.app)
login.fetch        // (request, env, ctx) => Response，裸 JS Worker 一行挂载
login.middleware   // Hono 中间件：Bearer 校验，set userId / sessionId
```

```ts
// 低层出口（不依赖工厂实例，供裸 Worker 的 requireAuth 双轨等场景）
import { verifyAccessToken } from "loginbase";
const { sub: userId, sid: sessionId } = await verifyAccessToken(secret, token);
```

**工厂为什么收 resolver `(env) => config` 而不是 config 对象**：Workers 的 binding 只在请求期以 `env` 出现，模块顶层拿不到；resolver 让库在首个请求时取配置并按 isolate 记忆化（`env` 对象在同一 isolate 内恒定，`WeakMap<env, config>`）。**`basePath` 例外**（2026-08-12 实现时修订）：Hono app 在构建期（模块加载时）就需要路由前缀，而 config 到请求期才可得，时序矛盾——故 basePath 为 `createLogin` 第二参数的静态选项，不进 config。两种消费形态都只需一行：

- Hono 消费方（Tono-Server）：`app.route("/", login.app)`——前缀由库内 `basePath` 承担，不再用 `app.route("/auth", …)` 外挂前缀，避免双重前缀。
- 裸 JS Worker（github-ai-trending-api）：`if (pathname.startsWith("/auth")) return login.fetch(request, env, ctx)`。

## 端点与协议草案

全部挂在 `basePath` 下（下表省略前缀）。错误响应统一 `{ error: string, ...附加字段 }`。

| 端点 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `POST /code/send` | `{email}` | `200 {cooldownSeconds: 60}` | `400 invalid_email`；`429 too_many_requests {retryAfterSeconds}`；`500 internal`（邮件发送失败） |
| `POST /code/verify` | `{email, code}` | `200 {accessToken, refreshToken, isNewUser?, user?}` | `400 code_expired / invalid_code`；`429 too_many_attempts`（第 5 次错，码即焚）；`500 internal`（`onVerified` 抛错） |
| `POST /refresh` | `{refreshToken}` | `200 {accessToken, refreshToken}` | `401 invalid_refresh_token {reason}`，`reason ∈ missing_token / session_not_found / session_revoked / session_expired / rotate_failed` |
| `DELETE /sessions` | Bearer | `204`（吊销当前会话） | `401 unauthorized` |
| `DELETE /sessions/all` | Bearer | `204`（吊销该用户全部会话） | `401 unauthorized` |

- email 归一化 = `trim().toLowerCase()`，格式校验 `/^\S+@\S+\.\S+$/`；unicode 大小写折叠、`+` 后缀别名**不处理**（声明为协议语义，两端一致即可）。
- `verify` 响应中 `isNewUser` / `user` 来自 `onVerified` 返回值原样透传——Tono 现有 wire 格式（`user.isPro` 等）由其钩子实现承接，线上客户端无感。
- **`/me` 不进库**：它读的是 users 表（业务档案），钩子化后移回 Tono 自己的 app，用 `login.middleware` 鉴权。这是「不做用户档案」边界的直接推论。
- body 校验沿用母本的手动解析（两三个字段），**不引 zod**——铁律允许 zod-validator，但用不上就不进依赖面。

## 会话与令牌模型（直接采用 Tono 已验证实现）

**双 token 分工（概念基线）**：登录态要同时满足三件事——每请求验身份（必须快）、可吊销（能踢人）、长期免登录（几个月）。单一凭证三者不可兼得：长命且可验 → 每请求查库；长命且免查库 → 签出即收不回；短命 → 用户频繁重登。拆成两个角色后各占两样：**access token 是通行证**——每个业务请求携带、服务端只验签不查库，代价是不可作废单张，用短命封顶泄露损失；**refresh token 是换证凭据**——只出现在 `/refresh` 一个端点、低频出网暴露面小，长命所以必须可吊销：服务端存哈希、换证时查库，吊销/轮换/重用检测全部长在这一侧。低频侧承担全部状态与安全机制，高频侧保持无状态的快——这就是 design.md 弃「不透明 token 每请求查库」方案的结构原因。

**Access token**：JWT HS256，TTL 1h（可配），载荷 `sub`（userId）+ `sid`（sessionId）。middleware 纯验签零查库；代价是吊销延迟 ≤ access TTL，对目标 App 风险等级已评估可接受（design.md 已记录弃「不透明 token 每请求查库」的对比）。

**Refresh token**：32 字节 CSPRNG，base64url 发给客户端；服务端 D1 **只存 SHA-256 hex**，且哈希本身就是 `sessions.id`（查找即 `WHERE id = hash(token)`，无第二索引）。泄库拿不到可用 token。

**轮换与 family**：每次 refresh 旋转出新 session 行（同 `family_id`），旧行 `revoked_at + replaced_by_id` 标记，D1 `batch` 保证插入/标记原子。登录（verify）开新 family。

**重用检测与救活**（Logto 时代「轮换竞态 → invalid_grant 僵尸登录态」一族问题的服务端根治，TrendingAI 2026-08-01 事故驱动）：

已 revoked 的 token 再次被提交时，不立即判盗用，先走 `tryRescueSession`：

1. 该行有 `replaced_by_id` 且直接后继仍 active → 链未被第二方推进，判定「丢回执的诚实重试」→ 从后继再轮换一次发新证（新行标 `rescued_at`），**rescued**；
2. 无后继或后继已 revoked → 链已前进，真重用 → 撤销整条 family，**not_eligible**；
3. 后继虽 active，但同 family 在 1h 窗口内救活已达 3 次 → 只可能是盗用方与本人交替刷新 → 同样撤销整链，**guardrail**。

三种结局都过 `onEvent` 记录（`outcome: rescued / reuse_revoked / guardrail_revoked`），不含 token 明文。

**过期**：`sessions.expires_at` 现状恒 NULL（refresh 永不过期，只被轮换/吊销终结）；`session.refreshTtlMs` 配置为将来收紧留口，默认 null 保持 Tono 行为。

**轮换的目的**：refresh token 是长命的不记名凭证（bearer），谁持有谁就是主人，是被盗价值最高的目标。轮换干三件事：

1. 把长命凭证切成短命链条——被盗 token 的有效期从「几个月」缩到「受害者下次刷新为止」；
2. **制造盗用检测信号（核心目的）**——不轮换时本人与盗用方共用同一 token，服务端永远无法分辨；轮换后链头唯一，双方各自刷新必有一方提交已作废的旧 token，「不可检测的静默盗用」被转化为「必然暴露的碰撞事件」，重用检测撤销整链即对该信号的响应；
3. 配合哈希存储，任意时刻仅链头有效，泄库拿到的历史行皆废纸。

该信号有先天噪声：**丢回执的诚实重试与真盗用在信号上完全同形**（都是「旧 token 再现」），竞态容忍设计的全部分歧就在去噪方式。

**与 Logto 及业界对照**（2026-08-12 查证；Logto 构建在 node-oidc-provider 上，refresh 语义即该库语义；Supabase 结论来自 supabase/auth `internal/tokens/service.go` 源码核对）：

| 派别 | 代表 | 重用「去噪」方式 |
|---|---|---|
| 零容忍 | Logto / node-oidc-provider | 无——consumed token 再现即报 `invalid_grant` 并撤销整条 grant 链 |
| 时间窗宽限 | Okta（默认 30s，可配 0–60s）、Auth0（Rotation Overlap Period，仅最近一代可重用） | 窗口内当重试，窗口外当盗用 |
| 状态判定 + 重发（混合） | Supabase | 第一分支查链状态：被提交的旧 token 是当前活跃 token 的直接 parent → 判丢回执，**把活跃 token 原样重发**（此分支无时间限制）；否则落入 reuse interval 时间窗兜底（默认 10s），窗外杀 family |
| 不轮换 | Firebase（长期单 token）、Duende IdentityServer（2024 默认改回可重用） | 放弃重用信号，靠账号事件吊销；立场是信号信噪比太差，推荐 sender-constrained（DPoP）直接免疫盗用 |
| 状态判定 + 再轮换（本库） | Tono / loginbase | 链未被推进（直接后继未使用）→ 判诚实重试，从后继**再轮换发全新对**；已推进 → 双方共存的铁证，杀链；救活计数护栏 1h/3 次封交替 |

- 规范基线 RFC 9700（OAuth 2.0 Security BCP，2025-01）：sender-constrained 或 rotation + reuse detection 二选一；一切宽限/救活都是各家实现层的工程妥协，规范未置一词。
- Logto 侧移动 App 属 public client → 每次刷新必轮换 + 重用零容忍，TrendingAI 2026-08-01 事故是这个安全姿态的机制性结果（非 bug）。另两处差异：oidc-provider 对机密客户端仅在 ≥70% TTL 时轮换、轮换续命上限一年；本库恒轮换、refresh 不过期。
- **判定条件业界已有，组合是 Tono 自选**：「链未推进 → 判诚实重试」与 Supabase 的 parent-of-active 分支机制等价（其源码注释同样写着 "client was not able to store the result"），有大规模生产验证。Tono 增量在两处：救活时**再轮换**而非重发——重发会让盗用方与本人收敛到同一 token、永久共存且检测永不触发；再轮换强制双方持证分叉、任一方救活即作废另一方的证，交替可见——以及 `rescued_at` **计数护栏**——交替可见才可封顶，未见开源先例。
- 状态判定 vs 时间窗的取舍：**误杀率最低**——App 被杀/长断网后分钟级的诚实重试，时间窗（10~60s）一律误杀（温和版 Logto 病灶），状态判定只看链有没有前进。**代价是旧证长尾**——链休眠期间（后继一直未用）被盗旧 token 无时限可救活；两个折扣：能偷到旧证的向量几乎总能同时偷到新证（纯旧证场景很窄）、双方一旦都活跃即进入交替并被护栏在 1h 内杀链封顶；将来可用 `refreshTtlMs`（已留口）给链加整体过期收紧。救活路径多两次 D1 查询（后继 + 护栏计数），低频端点无关痛痒。
- 场景矩阵（✅ 正确处理 / ❌ 误杀或漏检）：

| 场景 | 零容忍 | 时间窗 | Supabase 混合 | 本库 |
|---|---|---|---|---|
| 丢回执秒级重试 | ❌ 误杀 | ✅ | ✅ | ✅ |
| 丢回执分钟级重试（App 被杀/断网） | ❌ 误杀 | ❌ 误杀 | ✅ | ✅ |
| 盗旧证、链已推进 | ✅ 杀链 | ✅ | ✅ | ✅ |
| 盗链头、双方交替 | ✅ 首碰即杀 | ✅ | ❌ **收敛共存，永不可检测** | ✅ 护栏 1h 内杀链 |
| 同设备并发刷新 | ❌ 误杀 | ✅ | ✅ 重发幂等收敛 | ⚠️ 收敛但耗护栏配额 |

- 无全绿列：一、二、五行是可用性，三、四行是安全性，各派选了牺牲哪头。本库以「客户端单飞刷新」的配合义务换其余全绿——**护栏 3 次/1h 的预算按客户端有单飞纪律设定**（并发双刷新会触发救活、消耗配额），这是 loginbase-kt 把「token 获取互斥串行化」列为需求清单的服务端原因，两端是一套机制的两半。
- 本库场景是「公开客户端 + 无 DPoP 条件」，不轮换派路径不适用；design.md「救活机制从服务端根治 Logto 时代轮换竞态」的论断经此对照成立。

## 数据模型

**D1：`sessions` 表归库所有**，DDL 以 `migrations/0001_sessions.sql` 随包分发（含 `rescued_at` 与三个索引，与 Tono migrations 0002+0004 的合并端态一致）：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,   -- refresh token 的 SHA-256 hex
  user_id         TEXT NOT NULL,      -- onVerified 返回的 userId，库不解释
  family_id       TEXT NOT NULL,
  expires_at      INTEGER,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL,
  user_agent      TEXT,
  ip              TEXT,
  revoked_at      INTEGER,
  replaced_by_id  TEXT,
  rescued_at      INTEGER             -- 非 NULL = 此行由救活产生（护栏计数用）
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_family_id ON sessions(family_id);
CREATE INDEX IF NOT EXISTS idx_sessions_rescued   ON sessions(family_id, rescued_at);
```

users 表**不归库**——库对 `user_id` 只存不读，用户表结构、建号、试用赠送全在 `onVerified` 里由 App 完成。

**KV 键位**（全部自带 TTL，无需清理）：

| 键 | 值 | TTL |
|---|---|---|
| `code:{email}` | `{code, attempts, issuedAt}` | 600s |
| `cooldown:{email}` | `"1"` | 60s |
| `rl:email:{email}` | 计数 | 600s |
| `rl:ip:{ip}` | 计数 | 3600s |
| `oauth:state:{state}` | OAuth state（单次使用） | 600s |
| `oauth:otc:{otc}` | 一次性授权码载荷（单次使用） | 60s |

键无库前缀，**建议消费方给 loginbase 独立 KV namespace**（Tono 的 `EMAIL_CODES` 即此模式）；共用 namespace 的键前缀配置列入将来项。

## 限流与验证码

沿用 Tono 三层 + 验码上限，参数即协议语义（改动过 `protocol.md`）：

- 发码：60s 单邮箱冷却 → 单邮箱 3 次/10min → 单 IP 10 次/h（`CF-Connecting-IP`），先到先拒，`retryAfterSeconds` 返回对应窗口；
- 验码：6 位数字（`crypto.getRandomValues`），10min 有效，**5 次错误即焚**，验证成功即焚（单次使用）；
- 暴力空间：10^6 组合 × 每码 5 次尝试 × 发码限流，穷举不可行；码比较非常数时间，配合次数上限风险可忽略（记录在案，不做修复）。

发送顺序注意保持母本行为：**先发邮件成功，再写 code 与限流记录**——发送失败不烧掉用户的冷却窗口。

## 邮件

- 信道 Resend（`https://api.resend.com/emails`，Bearer key），与 Tono 生产同款；QQ/163 送达率验证与 DirectMail 备选见 design.md 风险节。
- 端态模板体系（第 2 步）：内置 zh/en 两套（`brand` 注入标题与正文），`templates` 整体覆盖钩子留给完全自定义；母本硬编码的 Tono 英文模板即 en 模板的雏形。
- 发送已是独立函数（`sendCodeEmail`），将来换信道 = 换实现，不动 handler；transport 接口抽象列入将来项，现在不做。

## 钩子

**`onVerified`**——库与 App 的唯一用户语义边界，邮箱验证/OAuth 身份确认成功后调用：

```ts
onVerified: async (identity: {
  email: string;                       // 已归一化
  provider: "email" | "github";
  providerUserId?: string;             // OAuth 时的外部身份 ID
  providerProfile?: unknown;           // OAuth provider 公开档案（GitHub = /user 裁剪到建档白名单，敏感字段库内剔除）；1.1.0 起
  providerAccessToken?: string;        // OAuth provider 的 access token，库只透传不存储（GitHub OAuth App token 不过期）；1.2.0 起
  requestMeta: { ip?: string; userAgent?: string };
}) => Promise<{
  userId: string;                      // 进 JWT sub 与 sessions.user_id
  isNewUser?: boolean;                 // 透传进 verify 响应
  user?: unknown;                      // 透传进 verify 响应，业务自定义形状
}>
```

- App 侧职责：查/建用户、送试用（Tono）、`app_users` 映射（TrendingAI）。
- 钩子抛错 → `500 internal`，验证码已焚（用户重新发码）；不做补偿事务，保持简单，记录为已知行为。
- 会话在钩子成功返回**之后**创建——钩子失败不留孤儿 session。

**`onLinked`**（1.2.0 计划，见 plan.md 第 4 步议题 2）——**已登录用户绑定第二身份**的语义出口。与 `onVerified` 的方向相反：`onVerified` **返回** userId（用外部身份换会话），`onLinked` **接收** userId（用已有会话认领外部身份）。

```ts
onLinked?: (identity: {
  userId: string;                      // 来自 state 载荷，绝不接受客户端传入
  provider: "github";
  providerUserId: string;
  email?: string;                      // 可选——userId 已定，email 只是附加信息
  providerProfile?: unknown;
  providerAccessToken?: string;
  requestMeta: { ip?: string; userAgent?: string };
}) => Promise<{ ok: true } | { ok: false; reason: string }>
```

- **冲突用返回值而非抛错表达**：「该外部身份已属他人」是预期业务结果，不是异常；抛错留给真异常（→ `internal`）。这是与 `onVerified` 有意的不对称。
- 库不裁决冲突（拒绝/换绑/幂等重复绑定全由 App 决定），只把 `reason` 映射成回跳参数——与 `onVerified` 把用户语义交给 App 同构。
- 未提供 `onLinked` → link 端点 `404 not_configured`（默认关闭、显式启用，同 Supabase 的 Manual Linking 开关）。

**`onEvent`**——结构化事件出口，默认实现即母本 `logEvent`（单行 JSON console.log，配合 Workers Logs）。事件至少覆盖 refresh 三种非常规结局；字段永不含 token/code 明文。

## github-oauth 插件（第 2 步，草案）

设计目标：token 永不进 URL 与系统日志（移动端 deepLink 回跳是重灾区），复用 `onVerified` 与同一套会话模型。

1. `GET /oauth/github/start?redirect={deepLink}` → 生成 `state` 存 KV（10min、单次）→ 302 GitHub authorize（server-side flow，`client_secret` 换码，GitHub OAuth App 不支持 PKCE）；
2. `GET /oauth/github/callback?code&state` → 验 state → 换 access token → GitHub API 取 primary + verified email 与 user id → `onVerified({provider:"github", providerUserId, email})` → `createSession` → 生成**一次性授权码** `otc` 存 KV（60s、单次）→ 302 `{deepLink}?otc=…`；
3. `POST /oauth/exchange` `{otc}` → 验证即焚 → 返回 `{accessToken, refreshToken, isNewUser?, user?}`（与 verify 同构）。

**link 分支（1.2.0 计划）**：`POST /oauth/github/link/start`（Bearer）→ 校验 redirect 白名单 → state 载荷扩为 `{ redirect, mode: "link", userId }` → 返回 `200 { authorizeUrl }`（不 302——浏览器导航带不了 `Authorization` 头，故必须两步）；callback **复用同一端点**（GitHub OAuth App 的 callback URL 注册在 GitHub 侧，多一个即多一处配置漂移），按 state 载荷的 `mode` 分流：无 mode 走现有 login 路径（字节不变），`mode==="link"` → `onLinked` → 不建会话、不发 token → `302 {redirect}?linked=github` 或 `?error=already_linked`。`mode` 显式写出而非靠 `userId` 是否存在推断，便于将来加流程。

deepLink 白名单进 `socials.github` 配置；错误路径与 TrendingAI 存量 `github_user_id` 映射细节见 `protocol.md`。**scope 自 1.2.0 起可配**（`socials.github.scope`，默认 `user:email`）：TrendingAI 需 `user:email public_repo`（star 写操作），Tono 用默认值。

## 包结构、依赖与构建

```
src/
  index.ts        # createLogin + verifyAccessToken 等公共出口
  config.ts       # LoginConfig 类型 + resolver 记忆化
  handler.ts      # Hono 子应用（send/verify/refresh/sessions）
  middleware.ts   # Bearer 校验中间件
  code.ts  rate_limit.ts  session.ts  token.ts  email.ts  log.ts
  templates/      # zh.ts / en.ts（第 2 步）
  plugins/github.ts（第 2 步）
migrations/0001_sessions.sql
test/             # vitest + @cloudflare/vitest-pool-workers
```

- **依赖**：`hono` 为 peerDependency（^4，子应用与消费方共享同一实例语义）；`jose` 为 dependency（^6，纯内部使用）；不引 zod（见协议节）。devDeps 限 typescript / vitest / @cloudflare/vitest-pool-workers / @cloudflare/workers-types / wrangler。
- **构建**：纯 `tsc` 出 ESM + d.ts（Workers 全 ESM，无需 bundler，省一个 devDep）；`package.json` `exports` 单入口，`files` 只含 `dist/` + `migrations/`（`docs/`、`test/` 天然排除）。
- **发布**：npm registry，tag 触发 CI + trusted publishing（见 design.md 分发节）。

## 测试策略

- 框架沿用母本：vitest + @cloudflare/vitest-pool-workers（miniflare 提供真 D1/KV，不 mock 存储层）；Resend 以 fetch mock 拦截。
- 测试双层分布：**单元/handler 级测试搬进本包**（code/session/token/rate_limit/email + auth_* 五组 HTTP 测试，改 import 指向包内 app）；**Tono-Server 保留其集成测试**（走它自己的 app 与真实挂载），改依赖本包后全绿即第 1 步验收——同一套断言在两个仓库分别守「库自身正确」与「抽取未破坏消费方」。
- 协议契约测试与 `protocol.md` 同步演进：错误码表、限流参数、救活行为各有对应断言，protocol 改动无测试跟随视为违反协议纪律（见 CLAUDE.md 铁律）。

## 平移策略（第 1 步 ↔ 端态）

第 1 步**原样平移**（铁律 3），只做机械改动：`c.env.X` 读法换成 config 注入、import 路径调整。Tono 业务语义（users upsert、90 天试用、`/me`）**暂留库内**，此时包是 Tono 专用（0.x，不供外部消费）；第 2 步钩子化把它们移回 Tono、库升 1.0 泛化。这样每步都有独立验证点：第 1 步 Tono 测试守「搬没搬错」，第 2 步 Tono 测试守「钩子化等价」。

| Tono-Server | loginbase | 第 1 步改动 |
|---|---|---|
| `src/auth/code.ts` | `src/code.ts` | 无 |
| `src/auth/rate_limit.ts` | `src/rate_limit.ts` | 无 |
| `src/auth/token.ts` | `src/token.ts` | 无 |
| `src/auth/session.ts` | `src/session.ts` | 无 |
| `src/auth/email.ts` | `src/email.ts` | `Env` → config 注入 |
| `src/auth/handler.ts` | `src/handler.ts` | `Env`/binding → config；业务块原样保留（第 2 步移出） |
| `src/middleware/auth.ts` | `src/middleware.ts` | `Env` → config |
| `src/lib/log.ts` | `src/log.ts` | 无（第 2 步接 `onEvent`） |
| `test/{code,session,token,rate_limit,email}.test.ts` + `auth_*.test.ts` | `test/` | import 路径 |
| `migrations/0002+0004` | `migrations/0001_sessions.sql` | 合并为单文件端态 |

## 安全考量清单

- refresh token 哈希存储（泄库不可用）；access token 无状态、短命；两者都不落日志。
- 验证码单次使用、5 次即焚、三层发送限流；非常数时间比较已评估可忽略。
- JWT secret 每 App 独立（token 不跨 App 互认，账号不互通的技术保证）；secret 轮换 = 全员重新登录，`kid` 双 secret 平滑过渡列入将来项。
- 吊销延迟 ≤ access TTL（1h）为已声明的模型代价；`DELETE /sessions*` 只终结 refresh 能力。
- 救活护栏（1h/3 次）封死「盗用方与本人交替刷新」的无限救活通道。
- 供应链：依赖最小集 + lockfile + trusted publishing/provenance（铁律 1 与分发节）。

## 已知边界与将来项

- **revoked session 行无清理**：轮换链会持续增长（Tono 现状即如此），将来项 = 消费方 cron 定期清 `revoked_at < now - 保留期` 的行；库文档给出建议 SQL，不内置调度。
- strict middleware（对敏感端点每请求查 session 吊销状态，牺牲零查库换即时吊销）——留口不实现。
- KV 键前缀 / sessions 表名前缀（与消费方命名冲突时）——YAGNI，先约定独立 namespace。
- 邮件 transport 接口抽象（DirectMail 备选落地时再抽）。

> 2026-08-12 第 2 步完成：`refreshTtlMs`（滑动过期）、`accessTtlSeconds`、双语模板、github-oauth 均已实现，wire 契约见 protocol.md。
