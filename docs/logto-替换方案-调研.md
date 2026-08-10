# Logto 替换方案调研

> 2026-08-10 调研。诉求：邮箱验证码登录目前必须经 Logto 托管 web 页（Custom Tab 加载 ~490KB SPA、无境内节点），移动端体验差，要换成 App 内原生 UI。
> 拍板范围：**全量替换 Logto**（GitHub + 邮箱一起迁），约束权重：CN 可达性、零/低成本、运维负担最小、为 iOS 铺路（四项全要）。

## 现状（迁移的起点）

- **客户端**：仅 Android 接入（iOS 是 NoopAuthManager，登录入口隐藏）。Logto Android SDK 3.0.0-beta，OIDC PKCE，Chrome Custom Tabs。
  - GitHub：directSignIn 直接 302 到 github.com，跳过托管页，体验尚可。
  - 邮箱验证码：无 directSignIn 等价物，必须加载托管页——**本次要解决的痛点**。auth_probe 埋点当初就是为「继续 Logto vs 自研」决策加的。
- **后端**：Logto Free 档 → access token 是 opaque token，`requireAuth` 每次跨洋调 Logto userinfo 在线校验 + 10 分钟 isolate 缓存。
- **身份层已解耦**：`app_users.user_id` 是自有 UUID，`logto_sub` 只是关联列，`github_user_id` 是 Pro/赞助判定的稳定锚点。这让迁移成本大幅降低。
- 邮件基础设施已有 Resend（newsletter 在用）。

## 结论

**推荐自建：邮箱 OTP + GitHub OAuth 直接做在现有 Worker + D1 + Resend 上。**

四项约束逐条对照：

| 约束 | 自建的答卷 |
|---|---|
| CN 可达性 | 复用 `api.trendingai.cn`，与现有 API 同域同链路，已被大陆用户日常验证 |
| 零/低成本 | 零新增（Resend 免费档 3000 封/月，OTP 量级很小） |
| 运维负担 | 零新增实体，逻辑并入现有 Worker |
| iOS 铺路 | 登录 UI + 流程全落 KMP commonMain（Ktor 调自家 API），iOS 接入零额外工作 |

次选 Supabase Auth（省开发量、supabase-kt 是真 KMP，但 CN 链路引入不可控变量，见下）。

## 快速淘汰名单

| 方案 | 淘汰原因 |
|---|---|
| Firebase Auth | 大陆完全不可用，一票否决 |
| Auth0 / Okta | 原生 embedded login 官方不推荐且限制多，主推 Universal Login 仍是 web 页——换个牌子的 Logto；CN 可达性同样无保障 |
| Stytch | API-first 原生友好，但按 MAU 收费偏贵，个人项目性价比低 |
| Logto + Bring Your UI | 已查证：BYUI 是把自己写的 **SPA 上传到 Logto Cloud 托管**，仍是浏览器加载网页，托管页无境内节点的根因不变，原生化无解 |
| Keycloak / Ory / SuperTokens / Logto 自托管 | 都要常驻服务器/容器 + 数据库；现有家当是 Cloudflare + GitHub Actions + 一个 Lambda 中转，为登录养服务器违反运维约束 |
| Clerk | 2026-02 起免费 50K MRU 很慷慨，但核心是 React/Web 生态，Android SDK 尚新、无 KMP 路径，与 Compose 自绘 UI 相性差 |

## 候选方案对比

| 维度 | 自建（Worker+D1+Resend） | better-auth（现有 Worker+D1） | Supabase Auth | Appwrite Auth |
|---|---|---|---|---|
| 邮箱验证码原生化 | ✅ 完全自控，纯 API | ✅ email-otp 插件 | ✅ `signInWith(OTP)` + `verifyEmailOtp`（Kotlin SDK） | ✅ `createEmailToken` + `createSession`（Android SDK） |
| GitHub 登录 | 标准 OAuth 自己写：Custom Tab → Worker 回调 → deep link 回 App | social + bearer 插件，deep link 回跳仍要自己接 | `signInWithOAuth` SDK 内置 | OAuth2 sessions SDK 内置 |
| CN 可达性 | ✅ **最优**：同现有 API 链路 | ✅ 同左 | ⚠️ 无大陆/港台节点（最近日韩），社区实测 REST ~700ms、DNS 污染/TLS 握手延迟时有报告 | ⚠️ 云区域 fra/nyc/syd，大陆可达性无公开数据，需实测 |
| 成本 | ✅ 零 | ✅ 零 | 免费 50K MAU | 免费 75K MAU |
| 运维负担 | 无新增实体；安全面自己兜 | 无新增实体；但引入 drizzle/kysely + 框架 schema，与现有裸 SQL migration 风格冲突；CF 适配有已知坑（D1 实例必须 per-request，否则生产 503） | 新增外部 SaaS 依赖 | 新增外部 SaaS 依赖 |
| KMP / iOS | ✅ **最优**：全在 commonMain | ✅ 同左（REST 直调） | ✅ supabase-kt 是原生 KMP 库（社区维护） | ⚠️ Android/Apple SDK 分离，无统一 KMP 客户端 |
| 后端改动 | 中：OTP 表 + session 表 + 三组接口；`requireAuth` 反而变快（D1 本地查询替代跨洋 userinfo） | 中：接入框架 + claims 适配层 | 小：改验 Supabase JWT（支持非对称签名，JWKS 离线验签） | 小：同左思路 |
| 存量迁移 | Management API 导出用户，按 email / `github_user_id` 映射回原 `user_id`，用户重登一次即可 | 同左 | 同左，但用户还要进 `auth.users`，双份账本 | 同左，双份账本 |
| 主要风险 | ①安全细节自己负责；②Resend 对 QQ/163 送达率需验证 | ①CF+D1 社区坑；②框架升级跟随成本 | ①CN 链路不可控；②先例：2026-02 印度封锁 Supabase 域名 8 天，单点域名风险真实存在 | ①CN 可达性未验证；②无 KMP 客户端 |

## 推荐方案：自建

规模判断：登录本质只有**两个流程**（邮箱发码验码、GitHub OAuth）加**一个 session 机制**。后端已手写配额、Pro 判定、用户档案这些更复杂的东西，登录是偏简单的一块。

```
客户端（commonMain，Ktor）                Worker（api.trendingai.cn）
┌─────────────────────┐
│ 邮箱输入 → 发码      │ ──POST /auth/email/send──→  限流 + 生成 6 位码存 D1 + Resend 发信
│ 填码 → 验证         │ ──POST /auth/email/verify─→  校验 → 建 session → 返回 token
│ GitHub 按钮         │ ──Custom Tab: /auth/github─→ 302 github.com → 回调换 code
│   deep link 收 token │ ←─cn.trendingai://callback── 建 session → 返回 token
└─────────────────────┘
```

### 关键设计点

- **session 用不透明 token + D1 表**（不用 JWT）：可即时吊销、可查活跃设备，`requireAuth` 一次索引查询；顺手消灭 Logto refresh 轮换的整族竞态问题（2026-08-01 invalid_grant 事故、CredentialGuard、tokenMutex 那几百行防御代码整体退役）。
- **迁移三步走**：
  1. Logto Management API 导出全部用户（email + GitHub identities），按 email / `github_user_id` 回填新凭证表，映射到原 `user_id`——Pro/收藏/配额全不丢；
  2. 双轨期 `requireAuth` 先验新 token、fallback 验 Logto（老版本 App 不断服）；
  3. 观察一两个版本后下线 Logto 路径。
- **安全兜底清单**（就这几条）：按邮箱 + IP 双维度限流；code 5 分钟过期、验证即焚；失败 5 次作废；常数时间比对。

### 风险与验证项

- **邮件送达率是最大的非代码风险**：上线前用真实 QQ/163 邮箱实测 Resend 送达；不行则 OTP 信道单独换阿里云 DirectMail（约 ¥2/千封，约等于零成本）。
- 不选 better-auth 的原因：它解决的问题（session 管理、插件生态）要么已有等价物、要么用不上，代价是把 drizzle/kysely 和框架 schema 塞进零框架的 Worker，还要跟随 CF 适配坑。想少写安全代码时它是备选，不是首选。
- 若最终倾向 Supabase Auth：先复用 auth_probe 模式对 `<project>.supabase.co` 做真实大陆用户可达性探测再拍板。

## 参考链接

- Logto Bring Your UI（确认仍是托管 SPA）：https://docs.logto.io/customization/bring-your-ui
- Supabase Kotlin signInWithOtp：https://supabase.com/docs/reference/kotlin/auth-signinwithotp
- supabase-kt（KMP 客户端）：https://github.com/supabase-community/supabase-kt
- Supabase 国内延迟讨论：https://ask.csdn.net/questions/8598092
- TechCrunch：印度封锁 Supabase 域名事件：https://www.techcrunch.com/2026/02/27/india-disrupts-access-to-popular-developer-platform-supabase-with-blocking-order/
- Appwrite Email OTP：https://appwrite.io/docs/products/auth/email-otp
- better-auth + Cloudflare Workers 集成：https://github.com/zpg6/better-auth-cloudflare
- Clerk 免费档提升至 50K：https://saasprices.net/blog/clerk-free-plan-changes
