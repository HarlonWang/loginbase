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
4. 版本线约定：0.1.x = 平移期 Tono 专用；1.0.0 = 钩子化完成、对外可用；此后协议演进走 1.x，**版本号即协议版本**。**配置 API 的破坏性变更不单独推 major**（2026-08-14 定，首例是 1.3.0 的邮件模板体系）——它不动 wire，随协议 minor 一起发，在 `protocol.md` 版本历史里显式标 BREAKING 并写清消费方要改什么。

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

### D 层观察期读数（2026-08-14 首次三源交叉）

结论：**双轨改造未伤及老版本用户，断言 3 在 D 层拿到数据支持**。

| 源 | 读数 | 判读 |
|---|---|---|
| Workers Logs `track` 打点 | 08-13 logto 132 / loginbase 30；08-14（至 17:30 CST）logto 113 / loginbase 8；08-11~12 无打点 | 08-11/12 空白正是双轨 08-13 才上线，日志起点自洽。loginbase 那 38 次**全部是真机验证**——D1 `sessions` 全表 12 行 / 3 个 user_id（本人 + harlonwang-test + 一个纯邮箱新建号），创建时刻与打点时段逐一吻合。线上真实用户仍 100% 在 logto 轨道，与「新版未发布」一致 |
| TrendingAI 客户端埋点（08-01 ~ 08-14 09:05 UTC） | 新代埋点版本（0.22+/1.x）日均：start 20.6→23.5、success 6.7→5.5、**error 4.2→0**、`auth_probe` ok 率 95.8%→**100%**；`session_expired_hint` 触发的登录无聚集（08-14 两次，同 08-04 水位）；配额类事件（`chat_quota_hit`/`pro_upsell_shown`）无跳变 | 老会话没被踢、配额键没漂移。**老版本（0.x）仍占 2675/3597 独立用户**，正是双轨要保的人群 |
| Logto 审计日志（08-11 17:25 ~ 08-14 16:51 CST） | 授权码换 token 40 次全成功、0 失败；交互类 Error 全是正常分支（`user.user_not_exist` 16 / `user.identity_not_exist` 21 / `user.missing_profile` 22 / 验证码输错 4） | Logto 轨道错误率持平基线 |
| email 哨兵 SQL | **94**（= 2026-08-13 回填后基线，未上升） | 上表「无洞」假设仍成立 |

**读数口径备忘**（下次取数直接照做，别重踩）：

1. **客户端埋点分两代**：`0.16~0.21` 只有 `sign_in_failed`，`0.22+` 才有 `sign_in_start / sign_in_error / auth_probe`。混算会得出「成功率 150%」这种鬼数，任何漏斗对比都必须先按世代分组。
2. **`track` 打点在 Workers Logs 里是结构化字段，不是 message 文本**：`console.log(JSON.stringify({event,track}))` 被自动展开，`$metadata.message` 为空。查询要按 `$metadata.type = 'cf-worker'` 过滤再 `groupBy: track`；用 message includes `"track"` 过滤恒返回 0（曾据此误判「打点没生效」）。wrangler 的 OAuth scope 不含 observability，只能走 dashboard 同源的 `/api/v4/accounts/{acc}/workers/observability/telemetry/query`。
3. **两侧日志的保留期不同，都短**（2026-08-14 实测，非文档推断）：**Workers Logs 7 天**——14/30 天窗口与 7 天窗口返回的总量完全一致（29602）、最早桶都停在 08-07，即账号（Workers Paid $5）的保留上限；**Logto 审计日志 3 天**——不带时间参数拉全量只有 906 条、最早 08-11 17:25。双轨上线前的服务端基线已永久不可得，阶段 3 的占比下行趋势不能指望事后回溯。

**顺带发现**（与双轨无关，已记入 design.md 单飞 refresh 节）：老版本 App 的 Logto refresh 交换失败率 17.4%，全为 `invalid_grant`，来自 16 个不同 IP 且密集成簇——并发刷新竞态的线上病例。

### 双轨生命周期（2026-08-12 对齐）

地基是「同一账号，两种凭证」：无论 Logto token 还是 loginbase token，后端都解析到同一 `user_id`（email / `github_user_id` 双键映射）。两种 token 可结构化区分（HS256 vs RS256 + issuer），requireAuth 按 alg/issuer 路由而非盲试。

| 阶段 | 状态 | 要点 |
|---|---|---|
| 1. 服务端先行（第 3 步上线日） | loginbase 轨道零流量，老 App 无感 | 零风险窗口自灰度；出问题摘挂载即回纯 Logto |
| 2. 新版 App 发布（第 4 步后） | 新增登录/注册全走新轨 | 见下方「老版本仍会产生新用户」与迁移桥决策点 |
| 3. 观察与收敛 | Logto 轨道占比下行 | requireAuth 打点 `track: loginbase\|logto`（第 3 步实现时即埋），退役决策唯一数据源 |
| 4. 退役 | 删 fallback 与 logto-auth.js，注销 Logto 租户；**注销前必做 email 终扫**（见下方三点式策略③） | `app_users` 映射永久保留（已是正式数据） |

**Paddle 接入引入的双轨代码（退役时需一并清理，2026-08-15 登记）**：

1. `src/lib/quota.js`：`auth.track === 'loginbase' ? auth.userId : null`（Paddle 判权键）。退役时塌缩成 `auth.userId`；双轨期不能提前删——Logto 轨 `auth.userId` 是 undefined，直传会 D1 绑定报错打挂现网 chat
2. `src/api/billing.js`：`userIdForAuth` 只认 loginbase 轨。退役时可简化为直取 `auth.userId`，非硬项

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

**服务端侧已上线（2026-08-13）**：github-ai-trending-api PR #32 合并部署（`50e28b6`）。migration 039 加 `app_users.gh_token_enc/gh_token_updated_at`（备份先行：`app_users` 238 行导出 410K）；AES-GCM 加密，`GH_TOKEN_KEY` 已配置、密钥存档 `HarlonWang/secrets` 的 `trendingai-api/`；`onVerified` 顺带存 token，`onLinked` 实现绑定（冲突拒绝、绝不改绑）；`GET/DELETE /api/github/token` 响应形状对齐 Logto Account API。测试 +12、全量 551 绿。**配置期发现的坑**：secret 经管道配置带尾随换行 → `atob` 抛错被 catch 吞成「未配置」→ 明明配了却不存 token 且完全静默，已加 `.trim()` 防御。**冒烟**：未登录/坏 token/过期 token 均 401；邮箱登录用户取 token 得 404（预期）；顺带在生产实证 `POST /auth/refresh` 可用且**确实轮换** refresh token（此前只有测试覆盖）。注：`github-ai-trending-api` 是私有仓，Sourcery 不可用，该仓 PR 无 AI 审查。

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

### TrendingAI 接入实录（2026-08-13，进行中）

**已完成**：composite build 接通（`local.properties` 配 `loginbase-kt.dir`）；`LoginbaseAuthManager` 实现既有 `AuthManager` 接口 → 6 个登录入口零改动；`LoginSheetHost` 取代方式选择器（邮箱两屏原生 + GitHub 按钮同屏）；token 取回切到自家端点（`LogtoAccountApi` → `GithubTokenApi`，响应形状对齐故 4 个 provider 与 `RepoStarService` 一行未改）；deepLink 全链路。

**生产端到端验证通过**：邮箱验证码登录（zh 模板、命中原账号）、GitHub 登录（Pro 权益打通、GitHub profile 数据正常、`gh_token_enc` 非空）。

**真机才暴露的四个问题**（都不是编译期或单测能发现的）：

| # | 问题 | 教训 |
|---|---|---|
| 1 | 后端 `loginbase` 锁在 1.1.0，1.2.0 的三个能力（scope 可配 / `providerAccessToken` / `onLinked`）**全部静默失效**，整套 token 保管形同虚设 | 冒烟断言（"邮箱用户取 token 得 404"）与故障表现重合 → **等于没验证**。能区分的断言是"GitHub 登录后 `gh_token_enc` 非空" |
| 2 | 客户端 `scope` 漏配，线上仍是 `user:email` | 议题定案写了但接入时漏了；靠顺手看 302 URL 才发现 |
| 3 | 关掉浏览器无回调 → 面板永远转圈 | **plan.md 与代码注释都写了「由 onResume 复位（见下）」，而那个实现根本不存在**——注释承诺大于代码，比漏写更能骗过 review |
| 4 | `MainActivity` 默认 standard launchMode → 回跳新建实例，表现为"跳回首页"，otc 无人消费 | Logto 时代这条由 SDK 的 manifest 注入，自建后没人提醒 |

**待办**：绑定入口改走 link 流程（`AccountLink` 去 Logto 化）；**业务请求 401 → 刷新 → 重试**（当前缺失，access token 过期后账户页直接显示加载失败）；C 方案升级过渡 UX；发版。

### 待讨论（挂起，动 TrendingAI 前需对齐）

- **OAuth 回跳机制是否下沉到 loginbase-kt**（2026-08-14 记，审查中提出）：当前边界是「库给 URL，消费方走完流程」——`githubSignInUrl()` / `githubLinkUrl()` 在库里，而**打开浏览器、deepLink 注册、回跳解析、取消兜底、接收 Activity 全在消费方**。design.md 的客户端范围只写了 AuthClient/TokenStore/AuthState/单飞，从未论证过这条线。

  **代价已经兑现**：第 4 步在 TrendingAI 侧踩的两个坑（关掉浏览器无回调导致面板永远转圈、回跳新建 Activity 实例导致 otc 无人消费）都与业务无关、且**任何用 loginbase 做 OAuth 的 App 都要各踩一遍**——第 5 步 Tono-Android 接入时会原样重来。

  **业界把这条线划在另一侧**：AppAuth（`RedirectUriReceiverActivity` + `AuthorizationManagementActivity`）与 Logto SDK（两个 Activity 都在 SDK manifest 里）都把浏览器往返关在库内，消费方只注入一个 scheme placeholder。

  **下沉的代价**：①Android 侧要引 `androidx.browser`（Custom Tabs）——**直接撞依赖最小集红线**，绕法是退回 `Intent.ACTION_VIEW` 或让消费方传「打开 URL」的回调、库只接管回跳一半；②库要带 Activity + manifest，「库不含 UI」这条边界需要更精确的措辞（Activity 属平台集成，不是 UI）；③iOS 的 `ASWebAuthenticationSession` 自带取消回调，与 Android 机制完全不同，两端各写一套。

  **决策取决于第 5 步**：Tono-Android 确定要接则下沉收益实打实；短期不接就是为假想的第二消费方付成本。

- **link 分支的错误回跳应自描述**（2026-08-14 记，做 TrendingAI PR #99 时暴露）：登录失败与绑定失败**都回跳 `?error=<reason>`**，形状完全相同（`internal` 两边都出现），客户端仅凭回跳 URL 分不出这次失败该给谁——只能自己维护「有一次绑定在飞」的标记，且该标记必须落盘（授权期间进程会被回收，回跳是冷启动）。**服务端在 link 分支的错误回跳里带上 `mode=link` 即可让回跳自描述**，客户端那个标记连同它的持久化整块删掉。属协议 minor，未定案。

- **OAuth 回跳劫持（原「Android App Links」）**（2026-08-13 记；**2026-08-14 查证后优先级下调，方案不定，继续挂起**）：当前回跳用 custom scheme（release `cn.trendingai://whl.trending.ai/auth`、debug 同 scheme + `.debug` host），Android 对它**无所有权验证**。Logto 时代同样如此，非本次引入。

  **2026-08-14 查证到的三件事**（下次捡起来时不必重查）：
  1. 多个 App 匹配同一 URI 时，Android 弹**选择器**（不保证路由到目标 App），不是静默劫持——用户选错或曾勾过「始终使用」才中招；
  2. **`POST /oauth/exchange` 的请求体只有 `{ otc }`，没有任何占有证明**（`src/plugins/github.ts`）——抢到 otc 即可在 60s 内换走整对令牌，**后果是账号接管**，不是信息泄露；
  3. 现有的服务端 redirect 白名单（结构化匹配）防的是**开放重定向**，对设备上的 scheme 抢注无效——白名单里那个地址本来就合法。

  **两条候选路线（都未定）**：①**PKCE 式绑定**——`start` 收 `code_challenge`、`exchange` 验 `code_verifier`，抢到 otc 也换不出令牌，把接管降级成「本次登录失败」；协议级、跨平台、跨消费方，成本约几十行 + 协议 minor。②**App Links**——`https://` + `assetlinks.json` 签名校验，系统直接路由；只覆盖 Android，且要处理 **Play App Signing 的证书指纹**（不是上传证书，经典坑）、debug 指纹、验证失败时链接落到浏览器需要真实兜底页、Android 12+ 验证更严。RFC 8252 是**两者都要**；若只做一件，①的收益面更广、成本更低。

  **不阻塞发版**：触发要求「设备上装了专门抢注这个 scheme+host 的恶意 App」+「回跳时选错」，不是可规模化利用的路径。
- ~~**单飞 refresh**~~ ✅ **2026-08-14 对齐完毕、讨论关闭**：机制通过（与 Auth0 CredentialsManager 同形，比 AppAuth 严、比 Supabase 保守），服务端护栏 1h/3 次的参数不用动。收尾两件已做（loginbase-kt `fix/singleflight-boundary`）：①「每进程一个实例」从隐式假设写成显式契约；②注入的 HttpClient 若没配超时，挂住的请求会永久持锁——按需补装 HttpTimeout 作保险丝。业界对照与「Ktor 内建单飞为何替代不了」记在 design.md 客户端节。

### 邮件语言与模板体系（2026-08-14 定案，待实施；原「邮件 locale」挂起项就此关闭）

**起源**：模拟器端到端实测发现「App UI 英文、收到中文验证码邮件」——邮件语言只由服务端静态配置决定，客户端语言完全不参与。**2026-08-14 重新过一遍时改判**：原方案（只加一个请求级 `locale` 参数、发 1.3.0）**只回答了「语言信号从哪来」，没回答「消费方能不能配模板」**；而现状 `templates` 与 `locale` 互斥——消费方一旦想改一句文案就永久失去多语言能力并连带丢掉 `brand`——是结构性缺陷，只做前者会把它固化。两件事一起做。

> **完整方案在别处，此处不重复**：服务端配置形状 / 三条规则 / 支持集 / 归一化匹配 / 不完整配置告警 / 演进纪律 / 业界对照 → `server-design.md`「语言与模板体系」节；客户端 `localeProvider` 与平台取值 → `design.md`「客户端库设计」节。本节只记**实施顺序、时序约束与验收**。

**四处改动**：

| # | 侧 | 改动 |
|---|---|---|
| 1 | 库（服务端） | `locale` → `fallbackLocale`（正名 + 放宽为 string）；`templates` 由整体覆盖改为**按 locale 分表 + 部件级可选**；模板签名 `(code) => string` → `(ctx) => string`；内置 zh/en 由三元判断重构成表；配置解析期告警 |
| 2 | 协议 | `POST /code/send` 请求体加**可选** `locale`（BCP 47），错误码表**零新增** → 客户端无任何新错误分支 |
| 3 | 客户端库 | loginbase-kt 加 `localeProvider`（默认 `platformLanguageTag`）+ 平台 expect/actual |
| 4 | 消费方 | ✅ TrendingAI 后端升级依赖 + 删掉旧键（[PR #36](https://github.com/HarlonWang/github-ai-trending-api/pull/36)，顺序 A 下连 `fallbackLocale` 都不配）；Tono-Server 无 diff |

**版本决定（2026-08-14 定）**：**发 `1.3.0`，含破坏性配置变更，且不做任何兼容逻辑**。即：旧键 `locale` 直接删、`templates` 旧形状不认，也不推 major。

依据是**受影响面实测为零**：① Tono-Server 与 github-ai-trending-api **都没用过 `templates`**（只用 `brand` + 内置）；② `email.locale` 只有 TrendingAI 配了 `'zh'`，而它的 loginbase 邮件轨道**在生产上从未发过一封信**——商店版走 Logto 托管页由 Logto 发信，而走 loginbase 的新版（PR #99）尚未发布。**这个配置项至今没有渲染过任何一封生产邮件**，改名不影响任何真实用户。既然如此，兼容层是为零个受益者付复杂度，major 号也只是给零个受影响方发的通知。

约束仍在：**消费方升级依赖与改配置必须同一个 PR**（裸 JS Worker 没有类型检查兜底），且冒烟断言要能区分——断言「中文用户收到的 subject 含中文」，而不是「接口返回 200」（后者在退化时同样成立，等于没验证；这正是第 4 步栽过的形态）。

**时序：三代客户端，其中 G1 是否存在取决于发版顺序**（TrendingAI 侧）

| 世代 | 发信方 | 传 locale | 现状 |
|---|---|---|---|
| G0 商店版（Logto 托管页） | Logto | — | 在线，不受本节任何改动影响 |
| G1 = PR #99 这一版 | loginbase | **不传** | **尚未发布** |
| G2 支持 locale 的版本 | loginbase | 传 | 待做 |

**关键事实（2026-08-14 确认）**：走 loginbase 发信的客户端一个都还没上线，**TrendingAI 的 loginbase 邮件轨道在生产上零流量**。因此本节所有改动当下影响面为零，而**G1 这个人群是否会存在，取决于两件事的先后**：

| 顺序 | 后果 |
|---|---|
| **✅ A（2026-08-14 选定）：locale 先落地，TrendingAI 首个 loginbase 版本直接是 G2** | **G1 从不存在**：无人靠兜底吃语言，服务端一步到位省掉 `fallbackLocale`（= 库内置 en），下面的观察与择时全部不需要。代价是 PR #99 等这条链走完再发 |
| B. PR #99 先发，locale 随后 | 产生 G1 人群：**`fallbackLocale: 'zh'` 必须保留到 G1 退场**——G2 发布那一刻 G1 仍是多数，此时兜底若已是 `en`，G1 的中文用户会集体从中文切成英文（净退化）。判据用 `onEvent` 的 `locale.fallback: true` 占比，看数不用猜 |

> 顺序 B 的这条约束修正了 2026-08-13 版「兜底改 en 需与客户端传参同批」的说法（同批仍会伤到 G1）；更早那句「改兜底对现有用户零影响、无需等新版发布」只在 G1 未发时成立，选 A 则它恰好一直成立。

**各批之间没有硬顺序耦合**（已核实：`src/handler.ts` 逐字段读请求体、**未用 zod 也无严格校验**，未知字段被静默忽略）→ 新客户端传 `locale` 打到老服务端不会 400，只会被忽略走兜底。故库、服务端、客户端可各自按节奏发；唯一的顺序问题就是上表 A/B 的选择。

**实施批次**（每批独立可验，批间可停）：

1. ✅ **库 1.3.0 已发布**（2026-08-14，PR #7 → tag → CI → OIDC，provenance 正常）：`resolveTemplates` 重写（三条规则 + 支持集 + 部件合并）、`fallbackLocale` 改名、`ctx` 化模板签名、内置表化、配置告警、`/code/send` 读 locale、`onEvent` 记 locale；`protocol.md` 同 commit 落 1.3.0。测试 87 → 116。
   > 执行实录：**Sourcery 本周额度用尽（`weekly rate limit`），该 PR 无 AI 审查**，改为自审，抓到 `templates` 里归一化认不出的键（如 `"中文"`）会被索引静默丢掉——语法合法却永不命中的死配置，补 `invalid_locale_key` 告警。三条核心规则做过反向验证（支持集放宽 / 一步截主语言 / 跨语言取件，还原任一即转红）；其中「一步截主语言」第一次**没转红**，说明测试没真区分，补 `zh-Hant-TW` 三级标签用例才有效——两级标签在两种实现下结果相同，是个会骗过 review 的盲区。registry 冒烟用**真包**跑了 14 条断言（含「旧键 `locale` 不再生效」的 BREAKING 实证）。
2. ✅ **客户端 loginbase-kt 已实现、未发版**（2026-08-14，[PR #4](https://github.com/HarlonWang/loginbase-kt/pull/4) 合并）：`localeProvider` + `platformLanguageTag()` expect/actual + 契约测试（23 → 33，含 host test 用 `Locale.ROOT` 构造「系统给不出语言」）；`PROTOCOL_VERSION` 1.3.0。**发版仍卡在 Maven Central 四个 secrets**（见第 4 步任务 1），故跟进 [issue #3](https://github.com/HarlonWang/loginbase-kt/issues/3) 按纪律**保持打开**（PR 正文的 `closes` 误关过一次，已重开）。
3. ✅ **消费方已上线**（2026-08-14，[PR #36](https://github.com/HarlonWang/github-ai-trending-api/pull/36) 合并即自动部署生产）：依赖钉死 `1.3.0`（不用 caret——配置 BREAKING 会随 minor 发，`^` 不再等于「可安全自动升级」）、删掉 `locale: 'zh'` 且**不配 `fallbackLocale`**、新增 5 个测试把断言落在**实际发给 Resend 的 subject** 上。TrendingAI 客户端随下一次发版自然获得 G2 能力（库默认自动传，**客户端零代码改动**）。
   > **反向验证推翻了一个原以为的风险**：单纯留着旧键 `locale: 'zh'` 是**无害**的（键被忽略、兜底落到库内置 en，恰好是想要的结果）；真正会退化的是**把旧值照搬到新键** `fallbackLocale: 'zh'`（3 个测试转红）。故升级动作的重点不是「别忘了改名」，而是「重新决定兜底语言应该是什么」。
4. **仅顺序 B 需要**：观察 `locale.fallback` 占比，G1 退场后删掉 `fallbackLocale: 'zh'`。顺序 A 下这一批不存在。

**验收与测试**：

- 库内：三条规则的组合矩阵（内置有/无 × 消费方无/部分/齐全）；逐级砍子标签（`zh-Hans-CN`/`zh_CN`/`en-GB`/`fr`/`zh-Hant`）；不完整配置告警的存在性；**`en + brand=Tono` 逐字节锁定测试必须继续绿**（第 2 步立的等价性证明，是这次重构的安全网）。
- 补两个**从未上过生产的组合**快照：`en + brand=TrendingAI`、**`zh + brand=Tono`**（后者随第 5 步生效，见下）。
- 客户端三条：①不配 provider → 请求体含 `locale` 且为 BCP 47 形态；②`localeProvider = { null }` → 字段**仍在**，值为平台语言（`null` = 没意见，回落而非关闭）；③平台语言也取不到时 → 字段**缺席**（而非 `null`）。
- 端到端：App 切英文 → 收英文邮件；切中文 → 收中文；传 `fr` → 收兜底语言且 `onEvent` 有 `fallback: true`。

### 升级过渡 UX（C 方案，2026-08-12 定）

背景：迁移桥已决策不做 → 新版无 Logto 栈，升级后所有登录用户以**干净未登录态**启动（无「过期」事件，是主动设计的行为）；TrendingAI 主信息流匿名可用，登录只守收藏同步/chat 配额/Pro，故不弹全屏登录引导（打扰匿名用户），也不静默降级（「收藏悄悄不同步」最伤信任）。方案 = **静默登出 + 定向轻提示**，约 50~80 行客户端代码：

1. **登录痕迹检测**（~20 行纯函数）：检查本地是否有登录过的痕迹——App 自有数据信号（缓存过 /api/me 资料、本地收藏表非空）或 Logto SDK 存储文件**存在性**（不解析内容，不依赖其内部格式）。只用于决定是否显示提示，**不参与任何鉴权**——误判最坏是多/少一条可关闭卡片，失败模式无害。
2. **一次性轻提示**（卡片/snackbar + 「已展示」偏好键）：触发条件 = 有痕迹 && 未登录 && 未展示过；文案例：「账号系统已升级，重新登录即可继续同步收藏 [去登录]」。启动不弹任何模态框，「我的」页照常显示未登录态，登录墙动作照常弹登录（现有逻辑兜底）。
3. **本地缓存不清（硬要求，验收项）**：① 升级/迁移代码不得清除任何用户数据（收藏本地缓存、资料缓存）；② 「升级导致的未登录态」不得复用「用户主动登出」的代码路径（或确认登出路径不清收藏缓存）。效果：未登录窗口期收藏照常可见（暂停同步），重登后 user_id 不变 → 云端全量拉取覆盖无缝接回；换账号登录的边界由 favorites 覆盖式同步天然纠正。

生命周期：触发人群单调归零（已展示/已重登/新装机/纯匿名均不再触发），保留 2~3 个发版周期后随例行清理删除，忘删无害——它是「告示牌」不是「基础设施」，不进退役监控。发布说明须写明「账号系统升级，需重新登录一次」。

## 第 5 步：Tono-Android 换用（不阻塞）

android target 接入 loginbase-kt，替换其现有登录实现；验收 = Tono-Android 登录回归通过。无时间压力，作为客户端库第二消费方的泛化性检验。

**⚠️ 接入会带来一次邮件语言变化，属预期而非回归**（2026-08-14 推演出）：Tono-Server 没配兜底（= 内置 `en`），而库内置支持 `zh`；Tono-Android 今天不传 locale，故所有人收英文邮件。换用 loginbase-kt 后客户端**默认自动上报 App 显示语言** → 中文用户开始收**中文邮件**（内置 zh + `brand=Tono`）。三点注意：

1. **现有安全网抓不到它**——第 2 步那条「en + brand=Tono 逐字节锁定」测试锁的是「en 模板长什么样」，不是「谁会收到 en 模板」；第 5 步做完它**依然全绿**，而生产行为已变。
2. **归因方向是反的**：邮件内容变了，第一反应会去查发信侧（服务端/模板/Resend），但根因是一次客户端发版，中间还隔着商店审核周期。
3. **`zh + brand=Tono` 从未上过生产**（Tono 一直 en、TrendingAI 一直 zh+自己的 brand），排版与字体栈没被真人看过——**先补快照测试再发**。

验收清单追加一条：中文用户邮件语言由英文变中文，符合预期。若不想要这个变化，写 `localeProvider = { "en" }`（一律英文，效果等同退回原状）——客户端**没有**「关闭上报」的开关，也不需要，见 design.md 客户端节的两条规则。

## 横切约定

- **每步一个独立验证点，未过不进下一步**；步内小任务可乱序，步间不可。
- 版本与 tag：本仓 `0.1.0`（第 1 步）→ `1.0.0`（第 2 步）→ 1.x，tag 为裸版本号只触发 npm publish；客户端仓自有版本线（`0.1.0` 起）与 publish workflow，互不触发（2026-08-13 分仓后定）。
- 协议纪律生效时点：第 2 步起「服务端 + protocol.md 同 commit」；第 4 步起追加「客户端仓开跟进 issue，版本落地前不关」。CI 自动校验协议版本一致性暂不加，协议开始高频演进时再补。
- **行为变更纪律**（2026-08-14 加）：有些改动不动 wire、不算协议变更，却会改变接入方可观察的行为——**库内置新增一门邮件语言**是首例（消费方对该语言的部分覆盖会从「整体回落」变成「合并」，且原有告警消失；传 `zh-Hant` 的用户会在库升级后无改动地从简体变繁体）。这类改动按 minor 发布，**release note 必须逐条列出行为差异**。同理内置模板文案变更（部件级覆盖的接入方会得到「旧主题 + 新正文」的组合，这是部件级覆盖的固有代价，Kratos 亦然）。
- 本仓库当前为骨架阶段的直接提交模式；第 1 步动工起，规模大的改动按全局 Git 工作流规则走分支/PR。
- **执行确认节奏**（2026-08-12 与实施约定一并定）：步间必停——每步验收点达成后汇报并确认再进下一步；外部动作必停——发 npm 包、修改关联仓库（Tono-Server 等）、生产部署、npmjs 网页配置，即使发生在步内也单独确认；步内连续执行不逐任务确认。需用户亲自参与的动作：npm 首发 OTP、npmjs trusted publishing 配置、生产部署。
