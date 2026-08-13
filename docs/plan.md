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
| ① 部署前 | ✅ 2026-08-13 已执行。对账结果：app_users 232 行（全有 logto_sub）× Logto 254 用户（22 个注册过未建档）；null-email 143 行中 **49 行有 Logto primaryEmail，全部回填成功**；冲突/重复/覆盖均为 0。**边界修正**：Logto 侧无 email 的达 94 行（远超「个位数」预期——GitHub 邮箱私有时 Logto 拿不到，rawData 亦空），其邮箱**在任何系统都不存在**、非回填可解；自愈机制：这批人升级后用 GitHub 登录时 loginbase 取 verified email 经 COALESCE 补上，此后邮箱登录亦可命中。M2M 凭证（密钥名 loginbase-migration，365 天）保留在 Logto 侧供③终扫 | 一次性，已完成 |
| ② 观察期 | 哨兵 SQL（例行看一眼）：`SELECT COUNT(*) FROM app_users WHERE logto_sub IS NOT NULL AND email IS NULL`——回填后**只应下降**（重登/升级自然填补）；上升 = 上表某个「无洞」假设被证伪，回来修。**基线：94（2026-08-13 回填后）** | 烟雾报警器，零成本 |
| ③ 阶段 4 退役前 | 最后一次导出 + 终态回填残余（预期为从未活动的沉睡账号）——**租户注销后 Logto 数据永久消失，此为最后机会**，退役 checklist 硬项 | 一次性 |

一句话：**快照修旧 + 代码防新自动维持完整性，哨兵证明维持真的在发生，终扫在数据源销毁前最后兜底。**

**收敛杠杆**（阶段 3 看打点数据再选，力度递增）：① 不干预，靠版本自然覆盖；② Logto 租户关闭新注册（保留登录）——账号层面真·只衰不增，代价是老版新用户注册失败需配升级引导；③ 最低版本强更，Logto 轨道清零进阶段 4。

**待决策点**：
1. **迁移桥：已决策不做**（2026-08-12）。实查推翻了「几十行」的初估：TrendingAI 客户端 token 存在 Logto 官方 SDK 内部（加密存储，绕开 SDK 读取不可靠），桥的唯一可靠实现是新版 App 把整个 Logto SDK 再捆绑一个发版周期（N 版双栈共存 + 迁移状态机 + 失败降级，N+1 版才删干净）。这份工程复杂度换的只是免去一次重登（邮箱收码 ~30s / GitHub 授权页 ~10s，数据零丢失，且 App 无登录墙锁死、不存在流失级风险）——不划算。执行口径：新版发布说明写明「账号系统升级，需重新登录一次」；升级即登出为预期行为。
2. **退役阈值**：如「Logto 轨道占比 <1% 持续 4 周」或按老版本 DAU 绝对值，阶段 3 有数据后再定。
**前置风险检查**：~~动工前查 Resend dashboard 里 Tono 的 QQ/163 邮箱域送达率与退信率~~ ✅ 2026-08-12 已查证达标（TrendingAI 自有域 trendingai.cn 一手数据：15 天 2,167 封、送达 99.12%、qq.com 验证码全达、163.com 零退信；详见 design.md 风险节），信道绿灯。

## 第 4 步：KMP 客户端 + TrendingAI 登录 UI

> **2026-08-13 定：客户端走独立仓 `HarlonWang/loginbase-kt`**（原计划的 `kotlin/` 子目录取消，理由见 design.md「两个仓库」节）。`protocol.md` 仍只住服务端仓，客户端仓不留副本；两仓独立版本线，tag 各为裸版本号，客户端从 `0.1.0` 起步。

1. 新建 `HarlonWang/loginbase-kt` 仓 + gradle 工程骨架（照抄 kmp-webview：vanniktech 插件、android + iosArm64 + iosSimulatorArm64、坐标 `wang.harlon:loginbase-kt`）+ 其自有 build/publish workflow（publish 照抄本仓 `publish.yml`，runner 换 macos）——可与第 3 步并行；
2. 核心实现：`AuthClient`（send/verify/refresh/signOut 的 Ktor 封装）、`TokenStore` 接口 + multiplatform-settings 默认实现、`AuthState` flow、**单飞 refresh**（护栏预算的客户端前提，见 server-design.md 场景矩阵）；
3. LogtoAuthManager 竞态经验逐条固化核对：token 获取互斥串行化、丢回执重试（与救活配合）、时钟偏差归因、invalid_refresh_token 判定与登出策略；
4. 协议契约测试：对 `protocol.md` 的错误码/字段断言两端各写一套（客户端侧 ktor MockEngine）；客户端仓 publish workflow 打通（macos runner，凭证从 HarlonWang/secrets 配 GitHub Secrets）；
5. TrendingAI shared 接入（commonMain 登录 UI），发版切换；分仓版协议纪律（服务端 + protocol.md 同 commit + 客户端仓跟进 issue）从此全面生效。

**验收**：loginbase-kt 发布可拉取；TrendingAI 新版邮箱 + GitHub 登录全流程可用；竞态清单逐条有对应测试或代码注释交代；升级过渡 UX 按下述 C 方案验收。

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
