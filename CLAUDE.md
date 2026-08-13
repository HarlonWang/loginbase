# loginbase

多 App 共用的登录底座（邮箱验证码 + 社交 OAuth + 会话管理）。**开工前先读 README.md 和 `docs/design.md`**——路线选择、API 草案、分发方式、落地五步全在里面；服务端完整技术方案（公共 API、协议草案、会话模型、平移映射）见 `docs/server-design.md`；命名相关看 `docs/naming.md`（含死名单，别重新讨论命名）；项目由来看 `docs/logto-替换方案-调研.md`。

## 关联仓库（本仓库外的源头与消费方）

| 路径 | 角色 |
|---|---|
| `/Users/wanghl/TonoProjects/Tono-Server` | **服务端母本**：`src/auth/`（code/session/token/rate_limit/email/handler）+ `test/` 的 auth 测试，落地第 1 步从这里平移；平移后 Tono-Server 改为依赖本包 |
| `/Users/wanghl/TrendingProjects/github-ai-trending-api` | 消费方（第 3 步）：裸 JS Worker，`/auth` 前缀挂载 `auth.fetch`；现有 Logto 校验在 `src/lib/logto-auth.js`，迁移走 requireAuth 双轨 |
| `/Users/wanghl/TrendingProjects/TrendingAI` | 消费方（第 4 步）：KMP 客户端；`androidApp/.../LogtoAuthManager.kt` 里的竞态防御经验是 loginbase-kt 的需求清单 |
| `/Users/wanghl/TonoProjects/Tono-Android` | 消费方（第 5 步，不阻塞） |

## 铁律

- **依赖最小集**：服务端 hono + jose（+ zod-validator），客户端 ktor + kotlinx-serialization + multiplatform-settings。加任何新依赖前先停下来问一遍值不值——auth 库是供应链攻击的最高价值目标。
- **协议变更三位一体**：服务端 + `kotlin/` 客户端 + `docs/protocol.md` 必须同一个 commit；单一版本线，一个 tag 锁定两端。
- **落地第 1 步不加新功能**：只平移 Tono 代码与测试，Tono-Server 现有测试通过即验收；钩子化、双语模板、github-oauth 插件是第 2 步的事。
- npm 分发走 registry 正式发包（`loginbase`，tag 触发 CI + trusted publishing），registry 是唯一分发路径。仓库不再被分发链路强制 public（2026-08-10 由 git-tag 方案改来，理由见 design.md 分发节）。
- KMP 分发走 Maven Central（`wang.harlon:loginbase-kt`，vanniktech 插件，tag 触发 CI，照抄 kmp-webview；凭证在 HarlonWang/secrets 的 `maven-publishing/`），iOS target 只能在 macOS 构建（2026-08-10 由 R2 静态 Maven 改来，理由见 design.md 分发节）。

## 当前状态

第 0/1/2/3 步已完成（2026-08-13）：`loginbase@1.1.0`（providerProfile + 安全白名单）上线；Tono-Server 与 github-ai-trending-api 均已接入并部署生产——TrendingAI 为双轨（loginbase 优先 + Logto fallback 不断老版本，lib/auth.js，track 打点为退役数据源），email 回填 49 行（哨兵基线 94 只应降）、GitHub OAuth App 新旧分立（旧改名 Legacy 待阶段 4 删）。C 层验收全过（含 oauth 命中原账号、回滚演练实测）。`kotlin/` 未创建。下一步 = 第 4 步 KMP 客户端（含 C 方案升级过渡 UX，见 plan.md）。观察项：TrendingAI 双轨 track 占比、email 哨兵、Tono refresh 事件频率。
