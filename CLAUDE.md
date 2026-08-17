# loginbase

多 App 共用的登录底座（邮箱验证码 + 社交 OAuth + 会话管理）。**开工前先读 README.md 和 `docs/design.md`**——路线选择、API 草案、分发方式、落地五步全在里面；服务端完整技术方案（公共 API、协议草案、会话模型、平移映射）见 `docs/server-design.md`；命名相关看 `docs/naming.md`（含死名单，别重新讨论命名）；项目由来看 `docs/logto-替换方案-调研.md`。

## 关联仓库（本仓库外的源头与消费方）

| 路径 | 角色 |
|---|---|
| `/Users/wanghl/TonoProjects/Tono-Server` | **服务端母本**：`src/auth/`（code/session/token/rate_limit/email/handler）+ `test/` 的 auth 测试，落地第 1 步从这里平移；平移后 Tono-Server 改为依赖本包 |
| `/Users/wanghl/TrendingProjects/github-ai-trending-api` | 消费方（第 3 步）：裸 JS Worker，`/auth` 前缀挂载 `auth.fetch`；现有 Logto 校验在 `src/lib/logto-auth.js`，迁移走 requireAuth 双轨 |
| `/Users/wanghl/loginbase-kt`（`HarlonWang/loginbase-kt`） | **姊妹仓**（2026-08-13 已建）：KMP 客户端库，独立版本线与 CI；协议以本仓 `docs/protocol.md` 为唯一权威，客户端仓不留副本。协议变更须在该仓开跟进 issue（现有 [#1](https://github.com/HarlonWang/loginbase-kt/issues/1) 跟进 1.2.0 的 link 流程） |
| `/Users/wanghl/TrendingProjects/TrendingAI` | 消费方（第 4 步）：KMP 客户端；`androidApp/.../LogtoAuthManager.kt` 里的竞态防御经验是 loginbase-kt 的需求清单 |
| `/Users/wanghl/TonoProjects/Tono-Android` | 消费方（第 5 步，不阻塞） |

## 铁律

- **依赖最小集**：服务端 hono + jose（+ zod-validator），客户端 ktor-client-core + kotlinx-serialization-json + kotlinx-coroutines-core。加任何新依赖前先停下来问一遍值不值——auth 库是供应链攻击的最高价值目标。
- **协议变更纪律（分仓版，2026-08-13 定）**：`docs/protocol.md` 是唯一权威且只住本仓，客户端仓不留副本。服务端实现 + `protocol.md` 必须同一个 commit，同时在 `loginbase-kt` 仓开跟进 issue，客户端版本落地前不关。**两仓各自独立版本线**，tag 为裸版本号，不追求版本号相等（客户端从 0.1.0 起步）。
- **落地第 1 步不加新功能**：只平移 Tono 代码与测试，Tono-Server 现有测试通过即验收；钩子化、双语模板、github-oauth 插件是第 2 步的事。
- npm 分发走 registry 正式发包（`loginbase`，tag 触发 CI + trusted publishing），registry 是唯一分发路径。仓库不再被分发链路强制 public（2026-08-10 由 git-tag 方案改来，理由见 design.md 分发节）。
- KMP 分发走 Maven Central（`wang.harlon:loginbase-kt`，vanniktech 插件，**在 `loginbase-kt` 仓**由其自有 tag 触发 CI，照抄 kmp-webview；凭证在 HarlonWang/secrets 的 `maven-publishing/`），iOS target 只能在 macOS 构建（2026-08-10 由 R2 静态 Maven 改来，理由见 design.md 分发节）。

## 当前状态

**第 0~3 步已完成**；**第 4 步接近完成，只剩发版**（2026-08-14）。

- **服务端**：`loginbase@1.2.0` 已发布（link 语义 + providerAccessToken/verifiedEmails 透传 + scope 可配）。**登录统计 1.4.0 已实现待发**（`feat/stats`）：`auth_events` 表 + 7 类事件 + `flow_id` 串 OAuth 三段，**默认开启**且失败不影响登录；指标口径与分层决策全在 `docs/stats-design.md`（讨论按 L1 边界→L2 指标→L3 数据模型分层定稿，连带问题进待议清单）。**消费方升级须执行 migration 0002**，否则统计静默不落库。
- **客户端库**：`HarlonWang/loginbase-kt` 已建仓，核心实现完成（AuthClient / TokenStore 双平台 / AuthState / 单飞 refresh，25 测试），**未发 Maven**——TrendingAI 目前经 composite build 吃本地源码（`local.properties` 配 `loginbase-kt.dir`，是必需配置）。四个 Maven Central secrets 未配。
- **后端消费方**（github-ai-trending-api，已部署生产）：GitHub token 加密保管（migration 039 + `GH_TOKEN_KEY`，密钥存档 `HarlonWang/secrets` 的 `trendingai-api/`）、`onLinked` 绑定、`GET/DELETE /api/github/token`、OAuth 白名单改用 wrangler vars、scope 补 `public_repo`。PR #32/33/34/35。
- **客户端消费方**（TrendingAI）：**PR #99 待审**（`feat/loginbase-auth`，9 commits）。已完成登录面板（邮箱原生两屏 + GitHub）、OAuth 回跳（透明中转 Activity）、token 取回换自家端点、绑定改走 link 流程、业务请求 401 重试、C 方案升级横幅。
- **生产真机验证过**：邮箱登录（命中原账号、重启恢复）、GitHub 登录（Pro 打通、`gh_token_enc` 落库）、升级横幅、回跳复用实例。**未验**：绑定 link 流程（需一个没绑 GitHub 的账号）。
- **待讨论（挂起，见 plan.md 第 4 步「待讨论」）**：①单飞 refresh；③Android App Links（custom scheme 劫持的根治）；④**OAuth 回跳机制是否下沉到 loginbase-kt**（当前边界：库给 URL、消费方走完流程；决策取决于第 5 步是否接 Tono-Android）。
- **邮件语言与模板体系**（原「邮件 locale」挂起项）：**`loginbase@1.3.0` 已发布**（2026-08-14，真包冒烟 14 条断言通过）——`locale`→`fallbackLocale` 正名（旧键直接删、不留兼容）、`templates` 改按语言分表 + 部件级、请求级 `locale`。客户端 `localeProvider` 已实现并合并（loginbase-kt PR #4），**未发 Maven**。**含配置 API 的 BREAKING 但不推 major**：受影响面实测为零（走 loginbase 的客户端尚未发布，`locale: 'zh'` 至今没渲染过生产邮件）。方案见 server-design.md「语言与模板体系」+ design.md 客户端节。消费方 github-ai-trending-api **已升级并部署生产**（PR #36：依赖钉死 1.3.0、删掉 `locale: 'zh'` 且**不配 `fallbackLocale`**、加 5 个把断言落在 Resend subject 上的测试）。**剩余**：发 TrendingAI PR #99（顺序 A：客户端首版即会上报语言，故不存在「不传 locale 的世代」）；**未做生产端到端验证**（要真发一封验证码邮件才能验语言）。
- **观察项**：TrendingAI 双轨 track 占比、email 哨兵（基线 94 只应降）、Tono refresh 事件频率。**2026-08-14 首次三源取数完毕**（读数、口径备忘、日志只留 3 天的取数纪律见 plan.md「D 层观察期读数」）：线上真实用户仍 100% 走 logto 轨道（loginbase 侧全是真机验证），老版本登录与会话无回归，哨兵持平 94。
