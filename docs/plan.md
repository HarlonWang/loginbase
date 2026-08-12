# loginbase 实施计划

> 2026-08-12 制定。把 [design.md](design.md) 落地顺序的五步展开为可执行任务清单、验收点与版本线；服务端结构决策见 [server-design.md](server-design.md)，两文冲突时以后者为准。步骤 1→2→3→4 串行（各有独立验证点），步骤 5 不阻塞随时可做；步骤 4 的 gradle 骨架可与步骤 3 并行搭建。

## 总览

| 步骤 | 产物与版本 | 验收点 | 前置 |
|---|---|---|---|
| 0. 发布设施 | 包骨架 + CI 两条 workflow | CI 测试绿；npm 首发打通 | 无 |
| 1. 平移 | `loginbase` 0.1.x（Tono 专用） | Tono-Server 现有测试全绿 | 0 |
| 2. 钩子化 | 1.0.0（泛化，可供外部消费） | Tono 测试依旧绿（等价性）+ 钩子路径新测试 | 1 |
| 3. TrendingAI 接入 | github-ai-trending-api 双轨上线 | 新注册走 loginbase；存量用户映射回原 user_id | 2 |
| 4. KMP 客户端 | `wang.harlon:loginbase-kt` + TrendingAI 登录 UI | 两端协议契约测试对齐；新版登录全流程可用 | 2（骨架可先行） |
| 5. Tono-Android 换用 | 择机 | 现有登录回归通过 | 4 |

## 第 0 步：发布设施（一次性，半天量级）✅ 2026-08-12 完成

1. 包骨架：`package.json`（ESM、`exports` 单入口、`files: dist+migrations`、hono peer / jose dep）、`tsconfig` ×2（开发/构建）、vitest + `@cloudflare/vitest-pool-workers` + 测试用 `wrangler.toml`（D1/KV binding）。
2. CI：`build.yml`（push/PR 跑测试）+ `publish.yml`（tag `[0-9]+.[0-9]+.[0-9]+*` 触发；npm job 先行，第 4 步再加 maven job——同一 workflow，一个 tag 锁两端）。
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

## 第 2 步：钩子化 + 增量（1.0.0）

1. `onVerified` 抽钩子：users upsert + 试用逻辑移回 Tono 的钩子实现；`/me` 移回 Tono 自有路由（用 `login.middleware`）；
2. `onEvent` 钩子（默认实现保持单行 JSON console.log）；
3. zh/en 内置邮件模板 + `brand` / `locale` / `templates` 配置；
4. github-oauth 插件（start / callback / otc exchange，见 server-design.md 草案）——**编码前先把协议细节落 `protocol.md`**；
5. `protocol.md` 全量落笔：端点、错误码、限流参数、轮换/救活语义（server-design.md 端点表为底稿）；此后服务端 + protocol.md 同 commit 纪律生效（kotlin/ 建立后升级为三位一体）；
6. 发 `1.0.0`。

**验收**：Tono 测试依旧全绿（钩子化等价性证明）+ 库内新增钩子/模板/oauth 路径测试。Tono 的 wire 格式（`user.isPro` 等）经钩子透传保持不变，线上客户端无感。

## 第 3 步：TrendingAI 接入

1. 基础设施：TrendingAI 的 D1 跑 sessions migration、新建独立 KV namespace、Resend 配置 TrendingAI 发件域、Worker secrets（JWT_SECRET 等）；
2. `index.js` 挂载：`if (pathname.startsWith("/auth")) return login.fetch(request, env, ctx)`；
3. `onVerified` 实现：`app_users` upsert（email 与 `github_user_id` 双键映射）；
4. requireAuth 双轨：新 token（loginbase `verifyAccessToken`）优先，fallback 现有 `src/lib/logto-auth.js`——老版本 App 不断服；
5. Logto 存量迁移：Management API 导出用户，按 email / `github_user_id` 映射回原 `user_id`，预写入映射表；
6. github-oauth 插件接入（deepLink 白名单 = TrendingAI scheme）。

**验收**：新注册走 loginbase 全流程可用；存量用户邮箱登录命中原 `user_id`（数据不丢）；老 App Logto token 照常可用。**回滚**：双轨本身即回滚机制，摘掉 `/auth` 挂载即回到纯 Logto。
**前置风险检查**：动工前查 Resend dashboard 里 Tono 的 QQ/163 邮箱域送达率与退信率（design.md 风险节），不达标先解决信道再接入。

## 第 4 步：KMP 客户端 + TrendingAI 登录 UI

1. `kotlin/` gradle 工程骨架（照抄 kmp-webview：vanniktech 插件、android + iosArm64 + iosSimulatorArm64、坐标 `wang.harlon:loginbase-kt`）——可与第 3 步并行；
2. 核心实现：`AuthClient`（send/verify/refresh/signOut 的 Ktor 封装）、`TokenStore` 接口 + multiplatform-settings 默认实现、`AuthState` flow、**单飞 refresh**（护栏预算的客户端前提，见 server-design.md 场景矩阵）；
3. LogtoAuthManager 竞态经验逐条固化核对：token 获取互斥串行化、丢回执重试（与救活配合）、时钟偏差归因、invalid_refresh_token 判定与登出策略；
4. 协议契约测试：对 `protocol.md` 的错误码/字段断言两端各写一套；`publish.yml` 加 maven job（macos runner，凭证从 HarlonWang/secrets 配 GitHub Secrets）；
5. TrendingAI shared 接入（commonMain 登录 UI），发版切换；协议三位一体纪律（服务端 + kotlin/ + protocol.md 同 commit）从此全面生效。

**验收**：loginbase-kt 发布可拉取；TrendingAI 新版邮箱 + GitHub 登录全流程可用；竞态清单逐条有对应测试或代码注释交代。

## 第 5 步：Tono-Android 换用（不阻塞）

android target 接入 loginbase-kt，替换其现有登录实现；验收 = Tono-Android 登录回归通过。无时间压力，作为客户端库第二消费方的泛化性检验。

## 横切约定

- **每步一个独立验证点，未过不进下一步**；步内小任务可乱序，步间不可。
- 版本与 tag：`0.1.0`（第 1 步）→ `1.0.0`（第 2 步）→ 1.x；一个 tag 同时触发 npm + maven（第 4 步后）两个 publish job。
- 协议纪律生效时点：第 2 步起「服务端 + protocol.md 同 commit」，第 4 步起三位一体。
- 本仓库当前为骨架阶段的直接提交模式；第 1 步动工起，规模大的改动按全局 Git 工作流规则走分支/PR。
- **执行确认节奏**（2026-08-12 与实施约定一并定）：步间必停——每步验收点达成后汇报并确认再进下一步；外部动作必停——发 npm 包、修改关联仓库（Tono-Server 等）、生产部署、npmjs 网页配置，即使发生在步内也单独确认；步内连续执行不逐任务确认。需用户亲自参与的动作：npm 首发 OTP、npmjs trusted publishing 配置、生产部署。
