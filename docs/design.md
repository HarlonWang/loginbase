# loginbase 设计决策

> 2026-08-10 定稿。承接 [logto-替换方案-调研.md](logto-替换方案-调研.md) 的「自建」结论，本文记录抽成公用能力后的路线选择、仓库设计与技术评估。

## 定位与边界

- **解决的问题**：登录 + 注册入口层——邮箱验证码（发码/验码）、社交 OAuth、会话生命周期（签发/刷新/轮换/吊销）。
- **不解决的问题**：用户档案、权益/订阅、跨 App 统一账号。用户语义经 `onVerified` 钩子还给各 App 业务侧（TrendingAI 接 `app_users` 映射，Tono 接 users 表送试用）。
- 命名上不叫 user-什么 正是这个边界的体现（见 [naming.md](naming.md)）。

## 路线选择：公共库，而非中心化服务

| | 路线 A：公共库（选定） | 路线 B：中心化 auth 服务 |
|---|---|---|
| 形态 | TS 包，各 App 的 Worker 挂载，数据在各自 D1 | 独立 Worker + 独立 D1，多租户 |
| 账号 | 各 App 独立 | 跨 App 同一账号 |
| CN 可达性 | 各 App 复用自己已验证的域名链路 | 多 custom domain 也可做到 |
| 新增运维实体 | 0 | +1 部署单元 + 1 D1，全 App 共同单点 |
| 复杂度 | 低：配置注入 | 高：邮件品牌/模板/OAuth 回调按租户参数化；JWT 须换非对称 |
| 演进 | 库边界设计好，将来可包一层升级为 B | 降级回 A 成本高 |

选 A 的核心理由：各 App 用户群与 Pro 模型完全不同（GitHub Sponsors 锚定 vs 邮箱注册送试用），统一账号眼下无产品收益，却要立刻支付多租户复杂度与单点风险。**如果将来要跨 App 统一账号，路线要重开**——这是当时明确保留的开关。

## Monorepo：一份协议，两个产物

服务端库与客户端库共享同一份 API 协议（端点、错误码、限流语义、轮换救活行为），**协议是本仓库的核心资产**。拆两仓协议漂移只是时间问题；单仓一次 commit 同改两端 + 契约文档，一个 tag 锁定两侧，**版本号即协议版本**。

- npm 包根在仓库根（`package.json` 用 `files` 字段排除 `kotlin/`），KMP 是 `kotlin/` 下的独立 gradle 工程。
- 协议变更纪律：服务端 + 客户端 + `protocol.md` 必须同 commit。

## 服务端库设计

从 Tono-Server 平移，**只做一个结构改动**：内联的「用户 upsert + 送试用」抽成钩子。

```ts
const auth = createLogin({
  bindings: { db, kv },                    // 各 App 自己的 D1 + KV
  email: { resendKey, from, templates },   // zh/en 模板、品牌可配
  jwt: { secret, ttl },                    // 每 App 独立 secret（账号不互通，token 不互认）
  onVerified: async (email) => userId,     // 用户档案钩子，业务语义在 App 侧
  socials: { github: { clientId, clientSecret, deepLink } },  // 可选插件
})
// 出口：auth.fetch（路由挂载）+ auth.middleware / verifyToken（业务接口鉴权）
```

- **裸 JS Worker 挂载**（TrendingAI 后端无框架）：Hono app 本质是 fetch handler，`index.js` 里 `if (pathname.startsWith('/auth')) return auth.fetch(request, env)` 一行接入，无需整体迁 Hono。
- **会话模型直接采用 Tono 已验证实现**：JWT access（HS256、1h、载 sub+sid、中间件零查库）+ 轮换 refresh（D1 只存 SHA-256 哈希、family 重用检测、丢回执救活 + 1h/3 次护栏）。曾评估过「不透明 token 每请求查库」方案，弃：吊销延迟 ≤1h 对目标 App 风险等级可接受，换来 requireAuth 零数据库往返；且救活机制从服务端根治了 Logto 时代「轮换竞态 → invalid_grant 僵尸登录态」一族问题（TrendingAI 2026-08-01 事故）。
- 限流沿用 Tono：KV 三层（60s 冷却、单邮箱 3 次/10min、单 IP 10 次/h），验码 5 次上限、验证即焚。

## 客户端库设计（loginbase-kt）

- 范围：`AuthClient`（send/verify/refresh/signOut 的 Ktor 封装）、`TokenStore` 接口（默认 multiplatform-settings 实现）、`AuthState` flow、**单飞 refresh**。
- 把 TrendingAI LogtoAuthManager 里沉淀的竞态经验一次性固化：token 获取互斥串行化、丢回执重试（与服务端救活机制配合）、时钟偏差归因、invalid_grant 判定。
- 消费方：TrendingAI shared（commonMain，iOS 白拿）、Tono-Android（android target）。

## 分发

- **服务端**：public 仓库 + npm git-tag 依赖 `github:HarlonWang/loginbase#semver:^1.0.0`，零发布设施。硬约束：github-ai-trending-api 由 Cloudflare Workers Builds 云端装依赖，私有 git 依赖无凭据必失败——**仓库必须 public**（或改走 npm registry）。
- **KMP**：R2 静态 Maven（计划 `maven.harlon.wang`），release workflow 在 macos runner 上 `gradlew publish` 后同步 R2。排除项：JitPack（Linux 构建机编不了 iOS target）、Maven Central（sonatype 流程过重）、GitHub Packages（拉包也要 token）。
- 发布沿用「打 tag 即发布」习惯：一个 tag，npm 侧 git tag 即分发，Maven 侧 CI publish。

## 技术选型：TypeScript（长期评估结论）

在 Cloudflare Workers 底座上 TS 是一等公民，auth 负载纯 I/O 密集，语言性能无关；Hono/jose 均 runtime 无关，真正的锁定在 D1/KV binding 而非语言。真实存在的局限及对策：

1. 类型安全只在编译期——运行时边界（请求 JSON、D1 行）用 zod/手动校验兜底；
2. npm 供应链是 auth 代码最大威胁面——依赖钉死最小集、lockfile 锁版本；
3. 生态时尚漂移——只依赖低层稳定库，库 API 面冻结后漂移在库内消化；
4. 跨语言逻辑不可复用——auth 本是协议边界，客户端 SDK 任何服务端语言都要单独写，非 TS 特有。

不为「长期」换 Kotlin/Rust 写服务端：换语言等于换平台，成本/运维/CN 链路全要重付，收益在 serverless 层兑现不了。

## 落地顺序（每步独立验证点）

1. **建仓 + 平移**：Tono 服务端代码和测试原样搬入，Tono-Server 改为依赖此包——其现有测试即抽取正确性验收（此步不加新功能）。
2. **钩子化 + 增量**：onVerified 回调、zh/en 模板、github-oauth 插件。
3. **TrendingAI 接入**：`/auth` 挂载 + requireAuth 双轨（新 token 优先、fallback Logto 不断服老版本）+ Logto Management API 导出存量用户按 email/`github_user_id` 映射回原 `user_id`。
4. **KMP 客户端库 + TrendingAI 登录 UI**（commonMain），发版切换。
5. **Tono-Android 择机换用**（不阻塞前四步）。

## 已知风险与验证项

- **Resend 对 QQ/163 送达率**：Tono 生产在用同款信道（send.tonote.app）——查 Resend dashboard 的 Tono 邮箱域分布与退信率即可拿到实证；不达标则 OTP 信道单独换阿里云 DirectMail（约 ¥2/千封）。
- TrendingAI 侧迁移的完整风险清单见 [logto-替换方案-调研.md](logto-替换方案-调研.md)。
