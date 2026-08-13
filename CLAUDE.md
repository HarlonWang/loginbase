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

- **依赖最小集**：服务端 hono + jose（+ zod-validator），客户端 ktor + kotlinx-serialization + multiplatform-settings。加任何新依赖前先停下来问一遍值不值——auth 库是供应链攻击的最高价值目标。
- **协议变更纪律（分仓版，2026-08-13 定）**：`docs/protocol.md` 是唯一权威且只住本仓，客户端仓不留副本。服务端实现 + `protocol.md` 必须同一个 commit，同时在 `loginbase-kt` 仓开跟进 issue，客户端版本落地前不关。**两仓各自独立版本线**，tag 为裸版本号，不追求版本号相等（客户端从 0.1.0 起步）。
- **落地第 1 步不加新功能**：只平移 Tono 代码与测试，Tono-Server 现有测试通过即验收；钩子化、双语模板、github-oauth 插件是第 2 步的事。
- npm 分发走 registry 正式发包（`loginbase`，tag 触发 CI + trusted publishing），registry 是唯一分发路径。仓库不再被分发链路强制 public（2026-08-10 由 git-tag 方案改来，理由见 design.md 分发节）。
- KMP 分发走 Maven Central（`wang.harlon:loginbase-kt`，vanniktech 插件，**在 `loginbase-kt` 仓**由其自有 tag 触发 CI，照抄 kmp-webview；凭证在 HarlonWang/secrets 的 `maven-publishing/`），iOS target 只能在 macOS 构建（2026-08-10 由 R2 静态 Maven 改来，理由见 design.md 分发节）。

## 当前状态

第 0/1/2/3 步已完成（2026-08-13）：`loginbase@1.1.0`（providerProfile + 安全白名单）上线；Tono-Server 与 github-ai-trending-api 均已接入并部署生产——TrendingAI 为双轨（loginbase 优先 + Logto fallback 不断老版本，lib/auth.js，track 打点为退役数据源），email 回填 49 行（哨兵基线 94 只应降）、GitHub OAuth App 新旧分立（旧改名 Legacy 待阶段 4 删）。C 层验收全过（含 oauth 命中原账号、回滚演练实测）。客户端仓 `loginbase-kt` 未创建（2026-08-13 定为分仓，不再有 `kotlin/` 子目录）。下一步 = 第 4 步 KMP 客户端（含 C 方案升级过渡 UX，见 plan.md）；第 4 步的两个协议级议题已定案并实现，**`loginbase@1.2.0` 已发布**（2026-08-13，详见 plan.md 第 4 步）：①GitHub token 取回走「钩子透传 + App 自存」（库只加 scope 可配 + providerAccessToken + verifiedEmails）；②新增「已登录用户绑定第二身份」语义（link/start + onLinked + callback 按 state.mode 分流，业界模式 A）。第 4 步任务 1 亦完成：`loginbase-kt` 仓已建（骨架 + CI + 协议错误码契约测试，三 target 编译验过），跟进 issue #1 已开。**未做**：新仓 Maven Central 四个 secrets 待配（本人操作）；客户端核心实现（任务 2~3）；TrendingAI 后端尚未接 onLinked 与 GitHub token 加密存储。观察项：TrendingAI 双轨 track 占比、email 哨兵、Tono refresh 事件频率。
