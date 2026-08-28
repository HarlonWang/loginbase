# loginbase

多 App 共用的登录底座（邮箱验证码 + 社交 OAuth + 会话管理）。**开工前先读 README.md 和 `docs/design.md`**——路线选择、API 草案、分发方式、落地五步全在里面；服务端完整技术方案（公共 API、协议草案、会话模型、平移映射）见 `docs/server-design.md`；登录统计的指标口径与数据模型见 `docs/stats-design.md`；**接入方必读 `docs/email-identity.md`**（GitHub 邮箱模型、为何不该拿邮箱当身份锚点）；实施进度与历次读数在 `docs/plan.md`；命名相关看 `docs/naming.md`（含死名单，别重新讨论命名）；项目由来看 `docs/logto-替换方案-调研.md`。

## 关联仓库（本仓库外的源头、消费方与姊妹底座）

| 路径 | 角色 |
|---|---|
| `/Users/wanghl/TonoProjects/Tono-Server` | **服务端母本**：`src/auth/`（code/session/token/rate_limit/email/handler）+ `test/` 的 auth 测试，落地第 1 步从这里平移；平移后 Tono-Server 改为依赖本包 |
| `/Users/wanghl/TrendingProjects/github-ai-trending-api` | 消费方（第 3 步）：裸 JS Worker，`/auth` 前缀挂载 `auth.fetch`；现有 Logto 校验在 `src/lib/logto-auth.js`，迁移走 requireAuth 双轨 |
| `/Users/wanghl/loginbase-kt`（`HarlonWang/loginbase-kt`） | **姊妹仓**（2026-08-13 已建）：KMP 客户端库，独立版本线与 CI；协议以本仓 `docs/protocol.md` 为唯一权威，客户端仓不留副本。协议变更须在该仓开跟进 issue（现有 [#1](https://github.com/HarlonWang/loginbase-kt/issues/1) 跟进 1.2.0 的 link 流程） |
| `/Users/wanghl/TrendingProjects/TrendingAI` | 消费方（第 4 步）：KMP 客户端；`androidApp/.../LogtoAuthManager.kt` 里的竞态防御经验是 loginbase-kt 的需求清单 |
| `/Users/wanghl/TonoProjects/Tono-Android` | 消费方（第 5 步，不阻塞） |
| `/Users/wanghl/eventbase`（`HarlonWang/eventbase`） | **姊妹底座**（非本仓依赖）：自建埋点，与本仓同构——服务端库跑在各 App 自己的 Worker、数据落各自 D1、协议只住服务端仓、KMP 客户端住姊妹仓。npm `eventbase@0.0.2`。它是 2026-08-18 依赖准入改判的触发点（登录事件与客户端埋点合表），但**loginbase 目前并未依赖它**，合表接线尚未做 |
| `/Users/wanghl/eventbase-kt`（`HarlonWang/eventbase-kt`） | 埋点 KMP 客户端，`wang.harlon:eventbase-kt` 0.1.0 已发 Maven Central（2026-08-20）；TrendingAI 已接入（替换 Aptabase） |

## 铁律

- **依赖准入（2026-08-18 由「依赖最小集」改判，理由见 design.md）**：auth 库是供应链攻击的最高价值目标，所以**审查来源，而不是一味压数量**。允许三类依赖，其余一律先停下来问值不值：
  1. **现有基座**——服务端 hono + jose（+ zod-validator），客户端 ktor-client-core + kotlinx-serialization-json + kotlinx-coroutines-core；
  2. **业界权威库**——四条判据全满足才算：① 是该生态的事实标准，由组织或多人维护、发布节奏稳定；② 发布带 provenance / trusted publishing（npm）或签名（Maven Central）；③ 传递依赖不超过 2 个且同样满足 ①；④ 无安装脚本（postinstall 等）。缺任何一条就退回「停下来问」；
  3. **自己的库**（`HarlonWang/*`）——同样要走 trusted publishing 发布；在库里**优先声明为 peerDependency**（同 hono 的处理），由消费方决定版本，避免同一 Worker 里装进两份。

  仍然拒绝：为省几十行代码的工具包、单人维护的新包或小众包、运行时联网或带安装脚本的包、为一个功能把整个框架拖进来的包。**不变**：版本钉死 + lockfile + trusted publishing/provenance——放宽的是准入数量，不是来源审查。
- **协议变更纪律（分仓版，2026-08-13 定）**：`docs/protocol.md` 是唯一权威且只住本仓，客户端仓不留副本。服务端实现 + `protocol.md` 必须同一个 commit，同时在 `loginbase-kt` 仓开跟进 issue，客户端版本落地前不关。**两仓各自独立版本线**，tag 为裸版本号，不追求版本号相等（客户端从 0.1.0 起步）。
- **落地第 1 步不加新功能**：只平移 Tono 代码与测试，Tono-Server 现有测试通过即验收；钩子化、双语模板、github-oauth 插件是第 2 步的事。
- npm 分发走 registry 正式发包（`loginbase`，tag 触发 CI + trusted publishing），registry 是唯一分发路径。仓库不再被分发链路强制 public（2026-08-10 由 git-tag 方案改来，理由见 design.md 分发节）。
- KMP 分发走 Maven Central（`wang.harlon:loginbase-kt`，vanniktech 插件，**在 `loginbase-kt` 仓**由其自有 tag 触发 CI，照抄 kmp-webview；凭证在 HarlonWang/secrets 的 `maven-publishing/`），iOS target 只能在 macOS 构建（2026-08-10 由 R2 静态 Maven 改来，理由见 design.md 分发节）。
