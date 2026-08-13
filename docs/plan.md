# loginbase 实施计划

> 2026-08-12 制定。把 [design.md](design.md) 落地顺序的五步展开为可执行任务清单、验收点与版本线；服务端结构决策见 [server-design.md](server-design.md)，两文冲突时以后者为准。步骤 1→2→3→4 串行（各有独立验证点），步骤 5 不阻塞随时可做；步骤 4 的 gradle 骨架可与步骤 3 并行搭建。

## 总览

| 步骤 | 产物与版本 | 验收点 | 前置 |
|---|---|---|---|
| 0. 发布设施 | 包骨架 + CI 两条 workflow | CI 测试绿；npm 首发打通 | 无 |
| 1. 平移 | `loginbase` 0.1.x（Tono 专用） | Tono-Server 现有测试全绿 | 0 |
| 2. 钩子化 | 1.0.0（泛化，可供外部消费） | Tono 测试依旧绿（等价性）+ 钩子路径新测试 | 1 |
| 3. TrendingAI 接入 | github-ai-trending-api 双轨上线 | 新注册走 loginbase；存量用户映射回原 user_id | 2 |
| 4. KMP 客户端 | 新仓 `loginbase-kt` → `wang.harlon:loginbase-kt` 0.1.x + TrendingAI 登录 UI | 两端协议契约测试对齐；新版登录全流程可用 | 2（骨架可先行） |
| 5. Tono-Android 换用 | 择机 | 现有登录回归通过 | 4 |

## 第 0 步：发布设施（一次性，半天量级）✅ 2026-08-12 完成

1. 包骨架：`package.json`（ESM、`exports` 单入口、`files: dist+migrations`、hono peer / jose dep）、`tsconfig` ×2（开发/构建）、vitest + `@cloudflare/vitest-pool-workers` + 测试用 `wrangler.toml`（D1/KV binding）。
2. CI：`build.yml`（push/PR 跑测试）+ `publish.yml`（tag `[0-9]+.[0-9]+.[0-9]+*` 触发 npm publish）。*（当时计划「第 4 步在同一 workflow 加 maven job，一个 tag 锁两端」，2026-08-13 分仓后作废：maven 发布归客户端仓自有 workflow。）*
3. npm trusted publishing：在 npmjs 侧为 `loginbase` 配置 GitHub Actions OIDC；**若首次发布不被 trusted publishing 支持，首版本地手动 `npm publish` 兜底，之后全走 CI**。
4. 版本线约定：0.1.x = 平移期 Tono 专用；1.0.0 = 钩子化完成、对外可用；此后协议演进走 1.x，**版本号即协议版本**。

## 第 1 步：平移（0.1.x，铁律 3 辖区）✅ 2026-08-12 完成

> 执行实录：0.1.0 本地手发（trusted publishing 需包先存在），发布后冒烟抓到 ESM 相对 import 缺 `.js` 扩展名（wrangler/esbuild 场景不受影响故测试未拦住），修复后 0.1.1 经 tag → CI → OIDC → provenance 全链路发布（途中修 publish.yml 版本同步的 --allow-same-version）；Tono-Server 切换 -718 行、67/67 测试全绿、生产部署 + 冒烟通过。refresh 事件日志观察为遗留项。

按 server-design.md 平移映射表执行，只做两类机械改动：`c.env.X` → config resolver 注入、import 路径。Tono 业务块（users upsert / 90 天试用 / `/me`）**原样留在库内**。

1. `src/` 六模块平移 + `createLogin` 工厂（resolver 记忆化、basePath 内置）+ `middleware.ts` / `log.ts`；
2. `migrations/0001_sessions.sql`（Tono 0002+0004 合并端态）；
3. 测试平移：五组 `auth_*.test.ts` + 五个单元测试进包内，Resend 用 fetch mock；
4. 发 `0.1.0`；
5. Tono-Server 切换：删 `src/auth/` 与 `src/middleware/auth.ts`，依赖 `loginbase`，挂载 `app.route("/auth", auth)` → `app.route("/", login.app)`；
6. 部署 Tono 生产，观察 `refresh` 事件日志（rescued / reuse_revoked / guardrail_revoked 频率与上线前一致）。

**验收**：Tono-Server 现有测试全绿（唯一标准）。**回滚**：Tono 侧单 commit 切换，revert 即回退。
**明确不做**：钩子、双语模板、oauth、任何行为变更。

## 第 2 步：钩子化 + 增量（1.0.0）✅ 2026-08-12 完成

> 执行实录：protocol.md 先行落笔并与实现同 commit（协议纪律自此生效）；Sourcery 审查修掉一个真问题——redirect 白名单 startsWith 可被子域伪装绕过（开放重定向 → otc 泄露），改结构化校验；库侧 70 测试、Tono 侧 67 测试全绿；en+brand=Tono 模板逐字节锁定，Tono 切换后邮件零变化；生产冒烟含 /auth/me（业务侧路由）与 oauth not_configured（未配置即不存在）。

1. `onVerified` 抽钩子：users upsert + 试用逻辑移回 Tono 的钩子实现；`/me` 移回 Tono 自有路由（用 `login.middleware`）；
2. `onEvent` 钩子（默认实现保持单行 JSON console.log）；
3. zh/en 内置邮件模板 + `brand` / `locale` / `templates` 配置；
4. github-oauth 插件（start / callback / otc exchange，见 server-design.md 草案）——**编码前先把协议细节落 `protocol.md`**；
5. `protocol.md` 全量落笔：端点、错误码、限流参数、轮换/救活语义（server-design.md 端点表为底稿）；此后服务端 + protocol.md 同 commit 纪律生效（第 4 步分仓后追加「客户端仓开跟进 issue」）；
6. 发 `1.0.0`。

**验收**：Tono 测试依旧全绿（钩子化等价性证明）+ 库内新增钩子/模板/oauth 路径测试。Tono 的 wire 格式（`user.isPro` 等）经钩子透传保持不变，线上客户端无感。

## 第 3 步：TrendingAI 接入 ✅ 2026-08-13 完成（D 层观察期进行中）

> 执行实录：库侧发现 VerifiedIdentity 需带 providerProfile → loginbase 1.1.0（含 Sourcery 揪出的敏感字段白名单裁剪）；双轨实现初版让老轨道行为漂移、44 个既有测试报警，改为「Logto 轨道字节级不变」后 525 既有测试零修改全绿；基础设施五项（KV/JWT_SECRET/migration 038 备份先行/email 回填 49 行/GitHub OAuth App 新旧分立）全部就绪后合并部署。C 层验收：①新轨邮箱全流程（zh 模板生产首秀，Gmail 秒收）②③oauth 全流程命中原账号（sub=原 user_id、pro:True 完好读出）+ state/otc 重放防护意外实证 ④track 打点生产实锤 ⑤回滚演练实测（/auth 404 业务 200，恢复后会话跨回滚存活）。验收手法备忘：GitHub 授权按钮有真人手势检测（合成点击无效）；Chrome 对自定义 scheme 跳转会二次加载 callback 造成 invalid_state 伪影（真实 App 不受影响）；wrangler kv list 是管理面、对 60s TTL 键不可靠，验收用 AUTH_DEEPLINK 临时指 https 页面从地址栏取 otc（用后即删）。断言 3（老 App Logto token 照常）依据 A 层 6 用例 + 生产老流量无异常，D 层观察期持续确认。

1. 基础设施：TrendingAI 的 D1 跑 sessions migration、新建独立 KV namespace、Resend 配置 TrendingAI 发件域、Worker secrets（JWT_SECRET 等）；
2. `index.js` 挂载：`if (pathname.startsWith("/auth")) return login.fetch(request, env, ctx)`；
3. `onVerified` 实现：`app_users` upsert（email 与 `github_user_id` 双键映射）；
4. requireAuth 双轨：新 token（loginbase `verifyAccessToken`）优先，fallback 现有 `src/lib/logto-auth.js`——老版本 App 不断服；
5. Logto 存量迁移：Management API 导出用户，按 email / `github_user_id` 映射回原 `user_id`，预写入映射表——**导出快照只负责历史存量初始化**；双轨期间 Logto fallback 轨道每次认证仍照常 upsert 映射（持续映射，见下方生命周期），晚到的 Logto 注册用户同样收敛到同一 `user_id`；
6. github-oauth 插件接入（deepLink 白名单 = TrendingAI scheme）。

**验收**：新注册走 loginbase 全流程可用；存量用户邮箱登录命中原 `user_id`（数据不丢）；老 App Logto token 照常可用。**回滚**：双轨本身即回滚机制，摘掉 `/auth` 挂载即回到纯 Logto。

### 验收方案（2026-08-12 对齐；背景：第 3 步上线时尚无新版 App，验证靠分层构造而非 UI 回归）

- **A 部署前**：requireAuth 双轨 6 用例（两轨 × 有效/无效/缺失）+ onVerified 映射单测（快照命中原 user_id / github_user_id 命中 / 新 email 建号 / 晚到 Logto 用户收敛）；测试设施看仓库现状，缺则照搬 loginbase 的 vitest-pool-workers 模式。
- **B 上线前**：存量迁移**对账报告**——导出数/写入数/冲突数三方核对 + 抽样人工核验 + 边界清单（同 email 多账号、GitHub 无公开 email）。
- **C 上线日**（loginbase 轨道零流量窗口，可自动执行）：① 新轨邮箱全流程（Gmail 自动收码）；② **灵魂断言**——存量账号分别以 loginbase token 与 Logto token 打同一业务端点，返回同一用户同一份数据；③ github-oauth 全流程（github_user_id 命中原账号）；④ `track` 打点计数核验；⑤ 回滚演练（摘挂载→老轨照常→重挂）。
- **D 上线后**：老版本 App 完整回归（fallback 零破坏）；观察期 Logto 轨道错误率持平基线、loginbase 轨道 refresh 事件形态正常。

| # | 验收断言 | 手段 |
|---|---|---|
| 1 | 新注册走 loginbase 全流程可用 | C① + C③ |
| 2 | 存量用户命中原 user_id、数据不丢 | B + C② |
| 3 | 老 App Logto token 照常可用 | A + C② + D |
| 4 | 两轨同账号 | C② |
| 5 | 打点就位（退役决策数据源） | C④ |
| 6 | 回滚路径实测可用 | C⑤ |

### 双轨生命周期（2026-08-12 对齐）

地基是「同一账号，两种凭证」：无论 Logto token 还是 loginbase token，后端都解析到同一 `user_id`（email / `github_user_id` 双键映射）。两种 token 可结构化区分（HS256 vs RS256 + issuer），requireAuth 按 alg/issuer 路由而非盲试。

| 阶段 | 状态 | 要点 |
|---|---|---|
| 1. 服务端先行（第 3 步上线日） | loginbase 轨道零流量，老 App 无感 | 零风险窗口自灰度；出问题摘挂载即回纯 Logto |
| 2. 新版 App 发布（第 4 步后） | 新增登录/注册全走新轨 | 见下方「老版本仍会产生新用户」与迁移桥决策点 |
| 3. 观察与收敛 | Logto 轨道占比下行 | requireAuth 打点 `track: loginbase\|logto`（第 3 步实现时即埋），退役决策唯一数据源 |
| 4. 退役 | 删 fallback 与 logto-auth.js，注销 Logto 租户；**注销前必做 email 终扫**（见下方三点式策略③） | `app_users` 映射永久保留（已是正式数据） |

**老版本仍会产生新用户（阶段 2 的精确表述）**：老版本的注册入口是 Logto 托管的，Logto 侧账号可能继续新增——但来源池封闭且萎缩（应用商店只分发新版，能在老版注册的仅限「装了老版未登录」的存量装机）。总流量趋势下行，但不单调、不为零。**设计对此的免疫就是持续映射**（任务 5）：晚到的 Logto 用户升级后按 email / `github_user_id` 收敛到同一 `user_id`，无需补丁快照。

### email 回填与三点式导出策略（2026-08-13 对齐）

**解决的问题**：生产 app_users 230 行中约 146 行 `email = NULL`——这批老用户经 Logto 用 GitHub 登录时授权范围不含 email，后端从未见过其邮箱；但**邮箱一直存在于 Logto 侧**（身份系统注册即有）。不回填的故障剧本：老 GitHub 用户升级新版后改用**邮箱验证码**登录 → email 锚点查不到他 → 被判为新用户建出第二个账号 → 收藏「消失」（数据实际无损，但他永远够不着）——账号分裂。他若点 GitHub 登录则 `github_user_id` 锚点命中、安然无恙，但无法控制用户点哪个按钮。导出 = 趁 Logto 租户注销前，把它独家掌握的 (logto_sub → email) 对照搬回自己表里，让邮箱登录这条新路径认得出老用户。

**过渡期为什么不需要周期性导出**——双轨期每类用户的 email 都有着落：

| 过渡期用户 | email 从哪来 |
|---|---|
| 快照前的老用户（146 洞的主人） | ① 快照回填一次性修完 |
| 过渡期在老版本新注册 | 现版本登录已带 email 授权 → 持续映射建档时顺手写入 |
| 过渡期在新版本注册/登录 | loginbase 库保证给 email（验证码占有证明 / GitHub verified） |
| 快照后沉睡、某天才升级 | 其行已被快照回填 |

洞的存量被①清零，增量被双轨代码（持续映射）自动堵住——**过渡期无导出任务**。

**三点式策略**：

| 时点 | 动作 | 性质 |
|---|---|---|
| ① 部署前 | ✅ 2026-08-13 已执行。对账结果：app_users 232 行（全有 logto_sub）× Logto 254 用户（22 个注册过未建档）；null-email 143 行中 **49 行有 Logto primaryEmail，全部回填成功**；冲突/重复/覆盖均为 0。**边界修正**：Logto 侧无 email 的达 94 行（远超「个位数」预期）。**根因 2026-08-13 查明**（查 Logto 控制台 GitHub connector）：其 scope 只配了 `public_repo`、从未含 `user:email`，GitHub 因此不开放 `/user/emails`，Logto 只能读 `/user` 公开档案的 email 字段——用户没设公开邮箱就是空。**不是拿不到，是没要**；这批人的邮箱在 Logto 侧确实不存在、非回填可解。自愈机制：这批人升级后用 GitHub 登录时 loginbase 取 verified email 经 COALESCE 补上（loginbase 插件要的正是 `user:email`，两边 scope 恰好互补），此后邮箱登录亦可命中。M2M 凭证（密钥名 loginbase-migration，365 天）保留在 Logto 侧供③终扫 | 一次性，已完成 |
| ② 观察期 | 哨兵 SQL（例行看一眼）：`SELECT COUNT(*) FROM app_users WHERE logto_sub IS NOT NULL AND email IS NULL`——回填后**只应下降**（重登/升级自然填补）；上升 = 上表某个「无洞」假设被证伪，回来修。**基线：94（2026-08-13 回填后）** | 烟雾报警器，零成本 |
| ③ 阶段 4 退役前 | 最后一次导出 + 终态回填残余（预期为从未活动的沉睡账号）——**租户注销后 Logto 数据永久消失，此为最后机会**，退役 checklist 硬项 | 一次性 |

一句话：**快照修旧 + 代码防新自动维持完整性，哨兵证明维持真的在发生，终扫在数据源销毁前最后兜底。**

**收敛杠杆**（阶段 3 看打点数据再选，力度递增）：① 不干预，靠版本自然覆盖；② Logto 租户关闭新注册（保留登录）——账号层面真·只衰不增，代价是老版新用户注册失败需配升级引导；③ 最低版本强更，Logto 轨道清零进阶段 4。

**待决策点**：
1. **迁移桥：已决策不做**（2026-08-12）。实查推翻了「几十行」的初估：TrendingAI 客户端 token 存在 Logto 官方 SDK 内部（加密存储，绕开 SDK 读取不可靠），桥的唯一可靠实现是新版 App 把整个 Logto SDK 再捆绑一个发版周期（N 版双栈共存 + 迁移状态机 + 失败降级，N+1 版才删干净）。这份工程复杂度换的只是免去一次重登（邮箱收码 ~30s / GitHub 授权页 ~10s，数据零丢失，且 App 无登录墙锁死、不存在流失级风险）——不划算。执行口径：新版发布说明写明「账号系统升级，需重新登录一次」；升级即登出为预期行为。
2. **退役阈值**：如「Logto 轨道占比 <1% 持续 4 周」或按老版本 DAU 绝对值，阶段 3 有数据后再定。
**前置风险检查**：~~动工前查 Resend dashboard 里 Tono 的 QQ/163 邮箱域送达率与退信率~~ ✅ 2026-08-12 已查证达标（TrendingAI 自有域 trendingai.cn 一手数据：15 天 2,167 封、送达 99.12%、qq.com 验证码全达、163.com 零退信；详见 design.md 风险节），信道绿灯。

## 第 4 步：KMP 客户端 + TrendingAI 登录 UI

> **任务 0 执行实录（2026-08-13）**：`loginbase@1.2.0` 经 PR #6（merge commit）→ tag → CI → OIDC 发布，provenance 正常，registry 冒烟通过（真包 import + link/start 返回 401）。Sourcery 审查抓到一处真问题——`(body.x ?? "").trim()` 遇非字符串抛 TypeError，把本该 400 的坏请求变成 500；排查发现是**全库同一模式共 6 处**（含无鉴权的 `/oauth/exchange`），抽 `trimmedField` 统一修掉，正常路径零变化。测试 70 → 87，其中防御类 5 个做过反向验证（还原旧实现即转红）。分仓纪律的跟进 issue 已开：[loginbase-kt#1](https://github.com/HarlonWang/loginbase-kt/issues/1)（客户端版本落地前不关）。

> **2026-08-13 定：客户端走独立仓 `HarlonWang/loginbase-kt`**（原计划的 `kotlin/` 子目录取消，理由见 design.md「两个仓库」节）。`protocol.md` 仍只住服务端仓，客户端仓不留副本；两仓独立版本线，tag 各为裸版本号，客户端从 `0.1.0` 起步。

0. ✅ **服务端补齐**（`loginbase@1.2.0` 已发布，见上方实录与下方两个议题小节）：`socials.github.scope` 可配、`onVerified` 的 identity 带 `providerAccessToken`（+ 可选 `verifiedEmails`）、**link 流程**（`link/start` + callback 分流 + `onLinked` 钩子）；protocol.md 与实现同 commit；
1. ✅ **已建**（2026-08-13）：`HarlonWang/loginbase-kt`，本地 `/Users/wanghl/loginbase-kt`。gradle 骨架照抄 kmp-webview（vanniktech、android + iosArm64 + iosSimulatorArm64、坐标 `wang.harlon:loginbase-kt`）；CI 两条——build 在 ubuntu 只跑 `testAndroidHostTest`（ubuntu 编不了 iOS，故 iOS 编译在本地验过三 target 全绿），publish 在 macos 由裸版本号 tag 触发。骨架内容：`PROTOCOL_VERSION` + `AuthError`/`RefreshFailure` 错误码枚举及契约测试（未知 wire 值落 UNKNOWN，服务端将来加码不炸老客户端）。**发布前待办：新仓的四个 Maven Central secrets 尚未配置**（值在 HarlonWang/secrets 的 `maven-publishing/`，需本人操作）；
2. ✅ **已实现**（2026-08-13，loginbase-kt PR #2）：`AuthClient`（send/verify/refresh/signOut/exchange/link 的 Ktor 封装）、`TokenStore` 接口 + Android(SharedPreferences)/iOS(NSUserDefaults) 平台实现（**同步落盘**，multiplatform-settings 已弃用，理由见 design.md 依赖收紧）、`AuthState` flow、**单飞 refresh**（互斥锁 + 进锁后重读复用，护栏预算的客户端前提，见 server-design.md 场景矩阵）；
3. LogtoAuthManager 竞态经验逐条固化核对：token 获取互斥串行化、丢回执重试（与救活配合）、时钟偏差归因、invalid_refresh_token 判定与登出策略；
4. 协议契约测试：对 `protocol.md` 的错误码/字段断言两端各写一套（客户端侧 ktor MockEngine）；客户端仓 publish workflow 打通（macos runner，凭证从 HarlonWang/secrets 配 GitHub Secrets）；
5. TrendingAI shared 接入（commonMain 登录 UI），发版切换；分仓版协议纪律（服务端 + protocol.md 同 commit + 客户端仓跟进 issue）从此全面生效。

**验收**：loginbase-kt 发布可拉取；TrendingAI 新版邮箱 + GitHub 登录全流程可用；竞态清单逐条有对应测试或代码注释交代；升级过渡 UX 按下述 C 方案验收；**GitHub 数据面（star / following / feed / profile）在新版上零退化**。

### GitHub token 取回（议题 1，2026-08-13 定案）

**问题**：TrendingAI 的整个 GitHub 数据面依赖用户的 GitHub access token，现由 Logto Secret Vault 托管（`LogtoAccountApi.fetchGithubToken` → `/api/my-account/identities/github/access-token`，客户端 `GithubTokenProvider` 进程内缓存、不落盘）。Logto 一退役这条链就断，且它是**阶段 4 退役的隐形卡点**——只要还在用，租户就注销不了。依赖面不止 star：

| 调用 | 无用户 token 的后果 |
|---|---|
| `PUT/GET /user/starred/...`（star 读写） | 完全不可用（写还需 `public_repo`） |
| following / repos / feed / 计数 | 技术上匿名可读，但匿名限流 60 次/h 按 IP 算（移动网络 NAT 共享出口更易撞），实际浏览撑不住；认证后 5000/h 按 token 算 |

**定案：钩子透传 + App 自存**（排除「库托管」= Secret Vault 等价物，理由见 design.md 定位边界；排除「服务端全代理」= 客户端 GitHub 数据面全改，工作量最大且配额仍按用户 token 算、无额外收益）。

| 侧 | 改动 |
|---|---|
| 库（1.2.0） | ① `socials.github.scope` 可配（默认 `user:email`）；② `onVerified` 的 identity 带 `providerAccessToken`（只透传、不存储、不再分发） |
| TrendingAI 后端 | `onVerified` 里把 token **加密**存 D1（AES-GCM，密钥走 Worker secret）+ 自建取回端点（Bearer 鉴权，等价替换 Account API） |
| TrendingAI 客户端 | `GithubTokenProvider` 只换取回 URL（`LogtoAccountApi` → 自家 API）；**4 个 provider/ViewModel 与 `RepoStarService` 一行不改**，保持进程内缓存、不落盘的现有姿态 |

**scope 定案：`user:email public_repo`**，登录时一次要全，不做增量授权。依据是 2026-08-13 查证的 Logto 现状（GitHub connector scope = `public_repo` **单项**，Secret Vault 开启）——重的那个 `public_repo` 用户现在就在授权，新版只多一条"读取邮箱地址"，**无体验退化**；两边 scope 恰好互补（Logto 有重的缺轻的，loginbase 反之），这也是那 94 行无 email 的根因（见第 3 步边界修正）。GitHub OAuth App 没有比 `public_repo` 更细的 star 权限（要 per-repo 得换 GitHub App，架构完全不同），维持现状是唯一选择。

**硬约束（验收项）**：① D1 不得明文存 token——`public_repo` token 泄露等于能改用户所有公开仓库；② 上线前 scope 必须配平，否则新版用户 star 全挂（现生产 loginbase 侧 scope 仍是 `user:email`，因新版未发故当前无害）。

**后补优化（不阻塞第 4 步）**：增量授权（登录只要 `user:email`，首次 star 时再补 `public_repo`）与 GitHub 撤销授权后的重新授权路径，都可复用议题 2 的 link 流程，待新版上线后再按数据评估。

### 已登录用户绑定第二身份（议题 2，2026-08-13 定案）

**要解决的问题（问题 A）**：Pro 权益的发放键是 GitHub 数字 ID（`pro_entitlements.github_user_id`），账号的身份键是 `app_users.user_id`；纯邮箱注册的账号 `github_user_id` 为 NULL，与任何权益记录都匹配不上——**赞助了也拿不到 Pro**。这不是假想：`SponsorLinkHost` 的注释记着 2026-07-29 首位赞助者付完钱被当免费用户拦 48 分钟，那整个组件就是为它建的补偿设施。让两者对上的唯一办法是把 GitHub 身份写进**他当前这个账号**，而这个动作目前**只有 Logto 能做**（关联页 `{endpoint}/account/social/{connectorId}`，见 `Constants.kt`；入口在 ProfileScreen 与 SponsorLinkHost 两处，回程靠 MainActivity 的 ON_RESUME 窗口对账）。**loginbase 完全没有这个语义**——它的 OAuth callback 只回答「这是谁在登录」，一律走 `onVerified` 找号/建号。

**不属于本议题的（问题 B）**：「GitHub 邮箱 ≠ 账号邮箱 → 用 GitHub 登录会建出第二个账号」的分裂风险，**Logto 时代同样存在**（2026-08-13 查证：Logto 的「自动关联具有相同标识符的账户」也是按 email 匹配，不等则建新用户 → 新 `logto_sub` → `app_users` 新行）。两边行为一致，loginbase 未引入新风险；反而因为要了 `user:email`、拿得到 verified 邮箱，消除了 Logto 时代「拿不到邮箱 → 托管页要用户手填 → 填错即分裂」这个额外的不确定环节。**故 B 是长期产品缺陷、不是回归，不由第 4 步背**；可选改善见下方。

| | Logto 时代 | loginbase |
|---|---|---|
| GitHub 邮箱 == 账号邮箱 | 自动关联 → 同一账号 | 静默按 email 收敛 → 同一账号 |
| GitHub 邮箱 ≠ 账号邮箱 | 建新用户 → **分裂** | 建新行 → **分裂**（行为一致） |
| 拿不到 GitHub 邮箱 | 托管页要求手填，填错即分裂 | 不会发生 |
| **已登录状态主动补挂** | ✅ 关联页 | ❌ **无此能力 ← 唯一的真回归** |

**定案：给库加「已登录用户绑定第二身份」的通用语义**，形态见 server-design.md 的 `onLinked` 与 link 分支。边界：

| 范围 | 决定 |
|---|---|
| 绑定动作的协议与流程（provider 无关，落在各 social 插件） | ✅ 做，1.2.0 |
| `onLinked` 钩子 + 冲突回跳 | ✅ 做 |
| unlink（解绑） | ❌ 不做——TrendingAI 也没有解绑入口 |
| 「列出我已绑定的身份」端点 | ❌ 不做——已绑什么是 App 的档案数据（`app_users.github_user_id`），属既定「不解决」边界 |
| 换绑裁决 | 库不管；TrendingAI 的 `onLinked` **拒绝换绑**（返回 `already_linked`）——换绑会让 Pro 权益随 GitHub ID 漂移，风险不对称 |

**业界对照**（2026-08-13 查证，形态属主流的模式 A）：Supabase `linkIdentity()`（要求已登录、候选身份已属他人则失败、Manual Linking 默认关闭需显式开启）、Keycloak Client Initiated Account Linking（把 nonce + user session id + client id + idp alias 哈希进发起链接）、Firebase `linkWithRedirect` 均同此形；我们的 state 由服务端生成并 KV 单次即焚，天然免疫伪造，比 Keycloak 的 HMAC 更简单。排除模式 B（Auth0 `link_with`：两次独立登录 + 服务端合并）——它要求第二身份能独立登录签发 token，而我们的 `onVerified` 在那一步就会建号，且我们不做用户合并。与这些产品的唯一实质差异：它们自带 identities 表，loginbase 不存身份档案、绑定结果经 `onLinked` 落在 App 的 `app_users`。

**客户端收益**：Logto 关联页是 web 单任务流程、**回跳不了 App**，所以现在要靠「用户手动返回 → ON_RESUME → 30 分钟窗口刷新身份 → markLinked 通知界面」补偿。我们的 callback 直接 302 回 deepLink——`REFRESH_WINDOW` / `shouldRefreshIdentity` / `AccountLinkOpenedAt` 偏好键 / MainActivity 的 ON_RESUME 分支**整块删除**，净减代码。

**问题 B 的可选改善（零成本，建议随 1.2.0 顺带）**：loginbase 已经拉了完整的 `/user/emails` 列表却只挑一个用（`github.ts`），把**全部 verified emails** 一并透传给 `onVerified`，App 侧即可用整个列表去匹配 `app_users.email`——零额外 API 请求，让「GitHub 上挂了多个验证邮箱、其中之一正是账号邮箱」的用户不再被误判为新人。它压缩分裂人群，但不消除（邮箱完全不重合者仍需走 link）。

### 登录 UI 形态（第 4 步 TrendingAI 侧，2026-08-13 定）

**变化的本质**：现在两条登录路都在 App 外（GitHub 走 Custom Tabs directSignIn，邮箱走 Logto 托管页），底部选择器正是被「App 内无处承载选择」倒逼出来的。新版变成**一内一外**——邮箱全程原生（`/code/send` → 原生验证码屏 → `/code/verify`），GitHub 仍需外部授权页（`start` → GitHub → deepLink 带 `otc` → `exchange`）。托管页那 ~490KB SPA、大陆 ~1s 的加载（76% 取消率的主要嫌疑）**归零**，这正是本项目最初的动机兑现。

1. **去掉方式选择器**，改为一个登录页（沿用 `TrendingBottomSheet`，比全屏页打断感低——多数入口是 star Snackbar 这类轻量触发）：邮箱输入 + 发送验证码，分隔线下「使用 GitHub 继续」；发送成功后**同一容器内切屏**到 6 格验证码（填满自动提交、支持整段粘贴、可返回改邮箱）。6 个登录入口与 `source` 埋点归因一行不改；代价是 `sign_in_method_shown/dismiss` 两个埋点退休。
2. **重发冷却用服务端返回的 `cooldownSeconds`**（60）倒计时，不写死。
3. **错误码 → 文案**：`invalid_email`（本地先校验，服务端兜底）/ `too_many_requests` + `retryAfterSeconds` →「请 N 秒后再试」/ `invalid_code` →「验证码不正确」**（协议不返回剩余尝试次数，文案不得写「还可再试 N 次」）** / `code_expired` →「已失效，请重新发送」/ `too_many_attempts` →「错误次数过多，请重新发送」/ `internal` → 通用失败重试。
4. **浏览器被用户关掉没有回调**（Android Custom Tabs 不像 Logto SDK 会回 `USER_CANCELED`）→ 必须在 `onResume` 复位 loading 态，否则 sheet 永远转圈；iOS `ASWebAuthenticationSession` 有取消回调，两端行为不一致需各自处理。
5. **埋点**：`sign_in_start/success/canceled/error` 保留（`method` 语义随选择器去除而调整）；**`auth_probe` 退休**——自有域 api.trendingai.cn 不再有 Logto 海外边缘那个「可达性失败伪装成用户取消」的观测盲区。
6. **iOS 白拿登录能力**：UI 在 commonMain，iOS 只差 deepLink 与浏览器桥接的 expect/actual（现为 `NoopAuthManager`、入口全隐藏）。开不开是产品决策，技术上不再是障碍。
7. 登录页只管「登进来」，**GitHub 关联入口不在此流程**（在账户页/升级对话框，走议题 2 的 link）。

### 待讨论（挂起，动 TrendingAI 前需对齐）

- **单飞 refresh**（2026-08-13 挂起）：实现已随 loginbase-kt PR #2 落地（互斥锁 + 进锁后重读复用，8 并发收敛为 1 次请求，反向验证过），但**本人要求列为待讨论点**，后续再一起过。涉及面：它是服务端救活护栏（1h/3 次）的客户端前提，两端是一套机制的两半（见 server-design.md 场景矩阵与 design.md 会话模型）；若讨论后改变客户端策略，服务端护栏参数可能要跟着重估。

### 升级过渡 UX（C 方案，2026-08-12 定）

背景：迁移桥已决策不做 → 新版无 Logto 栈，升级后所有登录用户以**干净未登录态**启动（无「过期」事件，是主动设计的行为）；TrendingAI 主信息流匿名可用，登录只守收藏同步/chat 配额/Pro，故不弹全屏登录引导（打扰匿名用户），也不静默降级（「收藏悄悄不同步」最伤信任）。方案 = **静默登出 + 定向轻提示**，约 50~80 行客户端代码：

1. **登录痕迹检测**（~20 行纯函数）：检查本地是否有登录过的痕迹——App 自有数据信号（缓存过 /api/me 资料、本地收藏表非空）或 Logto SDK 存储文件**存在性**（不解析内容，不依赖其内部格式）。只用于决定是否显示提示，**不参与任何鉴权**——误判最坏是多/少一条可关闭卡片，失败模式无害。
2. **一次性轻提示**（卡片/snackbar + 「已展示」偏好键）：触发条件 = 有痕迹 && 未登录 && 未展示过；文案例：「账号系统已升级，重新登录即可继续同步收藏 [去登录]」。启动不弹任何模态框，「我的」页照常显示未登录态，登录墙动作照常弹登录（现有逻辑兜底）。
3. **本地缓存不清（硬要求，验收项）**：① 升级/迁移代码不得清除任何用户数据（收藏本地缓存、资料缓存）；② 「升级导致的未登录态」不得复用「用户主动登出」的代码路径（或确认登出路径不清收藏缓存）。效果：未登录窗口期收藏照常可见（暂停同步），重登后 user_id 不变 → 云端全量拉取覆盖无缝接回；换账号登录的边界由 favorites 覆盖式同步天然纠正。

生命周期：触发人群单调归零（已展示/已重登/新装机/纯匿名均不再触发），保留 2~3 个发版周期后随例行清理删除，忘删无害——它是「告示牌」不是「基础设施」，不进退役监控。发布说明须写明「账号系统升级，需重新登录一次」。

## 第 5 步：Tono-Android 换用（不阻塞）

android target 接入 loginbase-kt，替换其现有登录实现；验收 = Tono-Android 登录回归通过。无时间压力，作为客户端库第二消费方的泛化性检验。

## 横切约定

- **每步一个独立验证点，未过不进下一步**；步内小任务可乱序，步间不可。
- 版本与 tag：本仓 `0.1.0`（第 1 步）→ `1.0.0`（第 2 步）→ 1.x，tag 为裸版本号只触发 npm publish；客户端仓自有版本线（`0.1.0` 起）与 publish workflow，互不触发（2026-08-13 分仓后定）。
- 协议纪律生效时点：第 2 步起「服务端 + protocol.md 同 commit」；第 4 步起追加「客户端仓开跟进 issue，版本落地前不关」。CI 自动校验协议版本一致性暂不加，协议开始高频演进时再补。
- 本仓库当前为骨架阶段的直接提交模式；第 1 步动工起，规模大的改动按全局 Git 工作流规则走分支/PR。
- **执行确认节奏**（2026-08-12 与实施约定一并定）：步间必停——每步验收点达成后汇报并确认再进下一步；外部动作必停——发 npm 包、修改关联仓库（Tono-Server 等）、生产部署、npmjs 网页配置，即使发生在步内也单独确认；步内连续执行不逐任务确认。需用户亲自参与的动作：npm 首发 OTP、npmjs trusted publishing 配置、生产部署。
