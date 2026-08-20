# loginbase 设计决策

> 2026-08-10 定稿。承接 [logto-替换方案-调研.md](logto-替换方案-调研.md) 的「自建」结论，本文记录抽成公用能力后的路线选择、仓库设计与技术评估。

## 定位与边界

- **解决的问题**：登录 + 注册入口层——邮箱验证码（发码/验码）、社交 OAuth、会话生命周期（签发/刷新/轮换/吊销）。
- **不解决的问题**：用户档案、权益/订阅、跨 App 统一账号。用户语义经 `onVerified` 钩子还给各 App 业务侧（TrendingAI 接 `app_users` 映射，Tono 接 users 表送试用）。
- **第三方 provider 的 API 凭据同属「不解决」**（2026-08-13 定）：OAuth 流程换到的 provider access token 经 `onVerified` **透传**给 App，库既不存储也不再分发——存不存、怎么发是 App 的产品决策（TrendingAI 要用它调 GitHub REST，Tono 永不需要）。理由与本节边界同源：auth 库存第三方凭据是攻击面的实质升级，而 token 只是 OAuth 流程的自然副产品，扔掉它才是信息损失。落地见 plan.md 第 4 步。
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
- 范围：`AuthClient`（send/verify/refresh/signOut/oauth exchange/link 的 Ktor 封装）、`TokenStore` 接口 + 平台实现、`AuthState` flow、**单飞 refresh**、**邮件语言上报**（`localeProvider` + `platformLanguageTag()`，见下）。
- **邮件语言上报（2026-08-14 定，随服务端 1.3.0 落地）**：客户端侧只有两个公开概念——`AuthClient(localeProvider: () -> String? = ::platformLanguageTag)` 与平台取值函数 `platformLanguageTag()`。**规则只有两条**：

  | 意图 | 写法 | 发出去的 `locale` |
  |---|---|---|
  | 跟随系统语言 | 什么都不写 | 平台语言，如 `zh-Hans-CN` |
  | App 内自选语言，没选时跟随系统 | `localeProvider = { settings.tag }` | 选了 → 该值；返回 `null` → **回落平台语言** |

  **`null` 只有一个含义：「我没意见」**（空串与 `und` 同）。刻意**不做「彻底不发」的开关**——唯一想得到的用途是第 5 步 Tono 若不要"中文用户改收中文邮件"这个变化，而那用 `localeProvider = { "en" }` 表达更直接（效果等同，且写明了意图是"一律英文"而非"关掉某个机制"）；真需要时加一个带默认值的布尔是向后兼容的，删不掉才麻烦。同理**不设调用级参数**——"同一 App 同一会话里对不同邮件用不同语言"的需求不存在。平台语言也取不到时（Android 给 `und`、iOS 给空数组）才真的不发字段，由服务端兜底，正常设备走不到。

  平台取值（2026-08-14 查证）：Android `Locale.getDefault().toLanguageTag()`——它**已跟随 per-app language**，且零依赖；**不用 `AppCompatDelegate.getApplicationLocales()`**（用户没手动设过时返回空列表、必须在 `Activity#onCreate` 之后调、还会拖进 appcompat 依赖），**不用 `toString()`**（给 `zh_CN`，非 BCP 47）。iOS `Bundle.main.preferredLocalizations.first`——它是**App 实际显示的语言**，而 `Locale.preferredLanguages.first` 是用户首选语言（App 未做该语言时两者不等）；取前者，因为这件事的起点就是「App UI 与邮件语言割裂」，取后者会造出新的割裂。每次调用现取不缓存（用户可能中途切语言）。
- **2026-08-13 依赖收紧**：原定的 `multiplatform-settings` 弃用，改为各平台自写十几行（Android `SharedPreferences`、iOS `NSUserDefaults`）。理由有三：①用途窄到不成比例（存两个字符串）；②Tono-Android 未必已有该依赖，届时是硬塞；③**落盘同步性是与服务端救活机制配套的正确性属性**——`SharedPreferences.apply()` 异步写在进程被杀时正好制造丢回执，而 multiplatform-settings 默认走 apply、要传参数才同步，把关键语义变成「记得给第三方库传对参数」。同批还砍掉 ktor 的 ContentNegotiation 两个依赖（请求体手工序列化）与 HTTP engine（消费方提供）。
- 把 TrendingAI LogtoAuthManager 里沉淀的竞态经验一次性固化：token 获取互斥串行化、丢回执重试（与服务端救活机制配合）、时钟偏差归因、invalid_grant 判定。
- **单飞 refresh 的边界与业界对照（2026-08-14 查证后定案，待讨论项①就此关闭）**：

  | 产品 | 做法 |
  |---|---|
  | **Auth0.swift / Auth0.Android** `CredentialsManager` | 串行队列 / synchronized，**只保证实例内**；文档明写「不要从多个实例调用续期方法」 |
  | **AppAuth**（OIDC 移动端参考实现） | **不做合并**——并发 `performActionWithFreshTokens` 会用同一个 refresh token 刷多次被服务端拒，[iOS #716](https://github.com/openid/AppAuth-iOS/issues/716) / [Android #309](https://github.com/openid/AppAuth-Android/issues/309) 长期开着，官方立场是「自己加同步」 |
  | **Supabase** auth-js | 做到**跨标签页**（Web Locks + BroadcastChannel），代价是孤儿锁挂死、无限等待死锁等一串生产故障 |
  | **Ktor** `Auth` 插件 | 官方文档明写内建单飞，**但只协调装了插件的那一个 `HttpClient`** |
  | **本库** | 互斥锁 + 进锁后重读复用，**每进程一个实例** |

  **线上实证（2026-08-14 首读；来源 Logto 审计日志 08-11 17:25 ~ 08-14 16:51 CST）**：老版本 TrendingAI（Logto 直连、客户端无单飞）的 refresh 交换 **185 成功 / 39 失败 = 17.4% 失败率，全部 `invalid_grant`**。三条特征坐实是竞态而非配置或个例：①失败来自 **16 个不同 IP**，不是单机偶发；②UA 全是 okhttp（App 内，非浏览器）；③时刻密集成簇（如 08-12 21:12:13 / 21:12:45 / 21:12:47 / 21:13:11 / 21:13:12）——正是「多个请求拿同一个 refresh token，第一个轮转成功、其余全废」的形状。该失败率在双轨上线（08-13）前的 08-11 即存在，与服务端改造无关。这给单飞 refresh + 服务端救活这对机制补上了**量化病例基线**：新版客户端铺开后，本项应显著低于 17%，可直接作为验收口径（Logto 侧衰减 + loginbase 侧 `refresh` 事件里 rescued 占比两头对照）。

  三条结论：①**我们与 Auth0 同形**——比 AppAuth 严（它根本不合并），比 Supabase 保守（不碰跨进程），「单实例约束」是这类 SDK 的通行边界而非偷懒；②**Ktor 的方案替代不了**——TrendingAI 的 commonMain 里就有 3 个独立 `HttpClient`（加库自己的共 4 个），插件级单飞管不到跨 client，两者是叠加关系（消费方可在自己的 client 上装 `Auth`，`refreshTokens` 回调里调 `authClient.refresh()`）；③**刻意不做跨进程锁**——失败代价不对称，没有它最坏是多刷一次、烧一格救活配额，有了它最坏是认证彻底卡死。
- **与业界的一处有意分歧**：主流是**定时器提前刷**（Supabase autoRefresh、MSAL 近过期即刷），本库是**纯 401 驱动的被动刷**。因为主动刷要读 `exp` → 依赖设备时钟，正是 Logto 时代「模拟器慢 63 秒直接登录失败」的病灶。用一次多余往返换掉整类时钟偏差问题。
- 消费方：TrendingAI shared（commonMain，iOS 白拿）、Tono-Android（android target）。

## 依赖准入（2026-08-18 由「依赖最小集」改判）

原红线只有「数量」一个杠杆，改判后按**来源**审查：现有基座、业界权威库（四条客观判据）、自己的库（`HarlonWang/*`，优先 peerDependency）三类放行，其余仍要停下来问值不值。判据全文见 README「设计红线」。

**改判的触发点**是埋点底座（调研见 `TrendingProjects/埋点自建-调研.md`；**2026-08-20 已落地为实物**：`HarlonWang/eventbase` + `eventbase-kt`，npm `eventbase@0.0.2` / Maven `wang.harlon:eventbase-kt@0.1.0`，与本仓同构的双仓结构，TrendingAI 已用它替换 Aptabase。**但 loginbase 至今未依赖它**——改判解除的是禁令，合表接线本身仍未做，要做时按准入第 3 类走）：登录事件要与客户端埋点合到一张表，最直接的做法是 loginbase 直接用埋点库，旧红线却把它逼成「loginbase 加 `stats.sink` 配置项、消费方在自己的 Worker 里手工注入 writer」的绕法——多一段容易漏配又静默失效的接线（同类事故已有一次：消费方升级包但没跑 migration，统计静默不落库），而安全上并无收益：那是自己的库、同样走 trusted publishing 发布。

判据里两条容易被忽略的用意：**「业界权威」必须配可当场查证的硬判据**（维护者数量、npm provenance 徽章、`npm ls` 的传递依赖、有无 install 脚本），否则这四个字等于没规则，每次都能自我说服；**自己的库优先 peerDependency**，是因为自己的库在信任维度更高、在版本维度风险反而更大——写成普通 dependency 时消费方 Worker 里可能同时存在库拖来的一份和自己直装的一份，两份各写各的表。

保持不变：版本钉死 + lockfile + trusted publishing/provenance。放宽的是准入数量，不是来源审查——供应链完整性仍是本库第一位的非功能属性。

## 分发

- **服务端**：npm registry 正式发包 `loginbase`（裸名，无 scope），tag 触发 CI 发布，用 npm trusted publishing（GitHub Actions OIDC，免长期 token，带 provenance）。
  - 初版方案曾选 git-tag 依赖（`github:HarlonWang/loginbase#semver:^1.0.0`），理由是零发布设施；2026-08-10 改为 registry，前提变化是已有 npm 账号与发包经验，「零设施」优势缩水（KMP 侧本就要 CI，npm 只是同一 tag 触发下多一个 job），而 registry 的收益对 auth 库全踩在点上：
    1. **版本不可变**——registry 同一版本号不能重发不同内容，git tag 可被 force 移动；对 auth 库是供应链完整性属性，与依赖准入铁律同源；
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
2. npm 供应链是 auth 代码最大威胁面——依赖按准入判据审查来源、钉死版本 + lockfile；
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
