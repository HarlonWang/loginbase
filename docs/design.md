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

## 两个仓库：一份协议，两个产物

服务端库与客户端库共享同一份 API 协议（端点、错误码、限流语义、轮换救活行为），**协议是本项目的核心资产**。`protocol.md` 住在服务端仓（错误码、限流参数、轮换救活语义都是服务端行为，权威在此），客户端仓 `HarlonWang/loginbase-kt` 只链接、**不留副本**。

- **2026-08-13 由 monorepo 改判为分仓**（`kotlin/` 尚未创建，零迁移成本；第 4 步动工前定案）。初版选 monorepo 的理由是「拆两仓协议漂移只是时间问题，单仓一次 commit 同改两端，一个 tag 锁定两侧」，改判基于三点复核：
  1. **monorepo 的机械保证比预期弱**——`protocol.md` 是 markdown、不可执行，两端契约测试无论同仓分仓都是人手写断言对着人读的文档；单仓唯一硬保证是「同一个 commit」这个 git 事实，而单人开发下它拦不住一个人分两次 commit，实际价值是提醒而非强制；
  2. **业界同形状项目主流即分仓**——OpenTelemetry（spec/proto 仓 + 各语言 SDK 仓）、Stripe（OpenAPI spec 仓 + 各语言 SDK 仓）、LSP 都是「协议一处 + 实现各仓 + 显式协议版本」，本项目引以为据的「协议版本与实现版本分离」正出自这些分仓项目；
  3. **两个产物早已完全解耦**——不同 registry、不同 runner（Maven 侧必须 macos）、不同成熟度（服务端已生产 1.1.0，客户端未出生）。单仓要维持这种解耦，反要付出前缀 tag（`loginbase@1.2.0`）、workflow tag 分流、发布前剥前缀等一整套复杂度；分仓后这些全部消失，两边各自回到裸版本号 tag。
- 附带收益：CI 不再因改 Kotlin 而白跑 TS 测试（反之亦然）；IntelliJ 的 KMP 工程与编辑器的 TS 工程索引/工具链互不干扰；第 5 步 Tono-Android 接入时面对的是纯客户端仓。
- **代价与补偿**：协议漂移从「commit 层机械阻止」降级为「靠纪律」。补偿手段是两端各留 `PROTOCOL_VERSION` 常量 + 变更走双仓 issue 留痕（见下方纪律）；**CI 自动校验暂不加**（2026-08-13 决定），协议真开始高频演进时再补。
- 协议变更纪律（分仓版）：服务端实现 + `protocol.md` 必须同 commit；同时在 `loginbase-kt` 仓开跟进 issue，客户端版本落地前不关。

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

- 仓库：`HarlonWang/loginbase-kt`（独立仓，见上节改判）；协议以本仓 `protocol.md` 为准，客户端仓 README 声明自己对齐到哪个 `loginbase@x.y.z`。
- 范围：`AuthClient`（send/verify/refresh/signOut 的 Ktor 封装）、`TokenStore` 接口（默认 multiplatform-settings 实现）、`AuthState` flow、**单飞 refresh**。
- 把 TrendingAI LogtoAuthManager 里沉淀的竞态经验一次性固化：token 获取互斥串行化、丢回执重试（与服务端救活机制配合）、时钟偏差归因、invalid_grant 判定。
- 消费方：TrendingAI shared（commonMain，iOS 白拿）、Tono-Android（android target）。

## 分发

- **服务端**：npm registry 正式发包 `loginbase`（裸名，无 scope），tag 触发 CI 发布，用 npm trusted publishing（GitHub Actions OIDC，免长期 token，带 provenance）。
  - 初版方案曾选 git-tag 依赖（`github:HarlonWang/loginbase#semver:^1.0.0`），理由是零发布设施；2026-08-10 改为 registry，前提变化是已有 npm 账号与发包经验，「零设施」优势缩水（KMP 侧本就要 CI，npm 只是同一 tag 触发下多一个 job），而 registry 的收益对 auth 库全踩在点上：
    1. **版本不可变**——registry 同一版本号不能重发不同内容，git tag 可被 force 移动；对 auth 库是供应链完整性属性，与依赖最小集红线同源；
    2. **解除「仓库必须 public」硬约束**——git 依赖时代 Workers Builds 云端装依赖无凭据、私有仓库必失败；registry 之后 public 与否降为普通偏好；
    3. **构建产物两难提前消解**——git 依赖发编译产物要么消费方 `prepare` 现场构建（慢、flaky），要么提交 `dist/` 进仓库；registry 发布时构建一次，消费方拿现成 tarball；
    4. **安装干净**——只拉 `files` 筛过的 tarball，不 clone 整个仓库。
- **KMP**：Maven Central 正式发包 `wang.harlon:loginbase-kt`（vanniktech maven-publish 插件，`loginbase-kt` 仓的 tag 触发其自有 CI，在 macos runner 上 `publishAndReleaseToMavenCentral`），照抄 kmp-webview 的成熟链路；Sonatype 凭证与 GPG 签名密钥在私有仓库 HarlonWang/secrets 的 `maven-publishing/`（quickjs-wrapper / feedback-sdk 同源）。
  - 初版方案曾选 R2 静态 Maven（计划 `maven.harlon.wang`），排除 Central 的理由是「sonatype 流程过重」；2026-08-10 改判：重的部分（账号、`wang.harlon` namespace 验证、GPG key、插件与 workflow 配置）已在 kmp-webview 全部付清，Central 零新增成本，且版本不可变 + 强制 GPG 签名 + 消费方零 repository 配置；R2 自建仓反要维护域名/bucket/同步 workflow，且对象可覆盖、无不可变性——与 npm 侧弃 git-tag 是同一条供应链论证。
  - 仍排除：JitPack（Linux 构建机编不了 iOS target）、GitHub Packages（拉包也要 token）。
- 发布沿用「打 tag 即发布」习惯，**两仓各自独立版本线**：各仓一个产物，tag 即裸版本号（服务端 `1.2.0`、客户端 `0.1.0`），无需前缀与分流。协议兼容关系由 `protocol.md` 的版本历史 + 客户端 README 的对齐声明表达，不靠版本号相等表达（客户端从 `0.1.0` 起步，不因服务端已到 1.1.0 而虚高）。

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
  - **2026-08-12 实证达标，风险关闭**：查证发现 TrendingAI 自有 Resend 账号（trendingai.cn 域，Logto 验证码 + newsletter 均经其发送），近 15 天 2,167 封、送达率 99.12%、退信率 0.88%（permanent 仅 2 封）、投诉率 0%；qq.com 验证码全 Delivered（15 天仅 1 封 newsletter 退信）、163.com 零退信、foxmail/aliyun 均 Delivered。迁移 loginbase 后信道不变（同账号同域），数据直接适用；DirectMail 备选无需启用。Tono 侧另账号（send.tonote.app）当日实测 gmail 3 秒送达。
- TrendingAI 侧迁移的完整风险清单见 [logto-替换方案-调研.md](logto-替换方案-调研.md)。
