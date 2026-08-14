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

- **服务端**：`loginbase@1.2.0` 已发布（link 语义 + providerAccessToken/verifiedEmails 透传 + scope 可配）。
- **客户端库**：`HarlonWang/loginbase-kt` 已建仓，核心实现完成（AuthClient / TokenStore 双平台 / AuthState / 单飞 refresh，25 测试），**未发 Maven**——TrendingAI 目前经 composite build 吃本地源码（`local.properties` 配 `loginbase-kt.dir`，是必需配置）。四个 Maven Central secrets 未配。
- **后端消费方**（github-ai-trending-api，已部署生产）：GitHub token 加密保管（migration 039 + `GH_TOKEN_KEY`，密钥存档 `HarlonWang/secrets` 的 `trendingai-api/`）、`onLinked` 绑定、`GET/DELETE /api/github/token`、OAuth 白名单改用 wrangler vars、scope 补 `public_repo`。PR #32/33/34/35。
- **客户端消费方**（TrendingAI）：**PR #99 待审**（`feat/loginbase-auth`，9 commits）。已完成登录面板（邮箱原生两屏 + GitHub）、OAuth 回跳（透明中转 Activity）、token 取回换自家端点、绑定改走 link 流程、业务请求 401 重试、C 方案升级横幅。
- **生产真机验证过**：邮箱登录（命中原账号、重启恢复）、GitHub 登录（Pro 打通、`gh_token_enc` 落库）、升级横幅、回跳复用实例。**未验**：绑定 link 流程（需一个没绑 GitHub 的账号）。
- **待讨论（挂起，见 plan.md 第 4 步「待讨论」）**：①单飞 refresh；③Android App Links（custom scheme 劫持的根治）；④**OAuth 回跳机制是否下沉到 loginbase-kt**（当前边界：库给 URL、消费方走完流程；决策取决于第 5 步是否接 Tono-Android）。
- **已定案待实施**：**邮件语言与模板体系**（2026-08-14，原「邮件 locale」挂起项关闭）——发 `loginbase@2.0.0`（protocol 1.3.0）：`locale`→`fallbackLocale` 正名、`templates` 改按语言分表 + 部件级、请求级 `locale`、客户端 `localeProvider`。方案见 server-design.md「语言与模板体系」+ design.md 客户端节，实施顺序与时序约束见 plan.md 同名小节。**唯一有时机要求的动作**：TrendingAI 删掉 `fallbackLocale: 'zh'` 要等不传 locale 的 G1 版本退场（看 `onEvent` 的 `locale.fallback` 占比）。
- **观察项**：TrendingAI 双轨 track 占比、email 哨兵（基线 94 只应降）、Tono refresh 事件频率。
