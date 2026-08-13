# loginbase

> The shared login foundation for my apps — email OTP + social OAuth + session management.
> Cloudflare Workers server library + Kotlin Multiplatform client.

多 App 共用的登录底座：邮箱验证码登录、社交 OAuth（GitHub 等）、会话管理（refresh 轮换 + 重用检测 + 丢回执救活）。服务端库跑在各 App 自己的 Cloudflare Worker 里（数据在各自 D1，不做中心化账号），客户端库以 Kotlin Multiplatform 提供，住在姊妹仓 [HarlonWang/loginbase-kt](https://github.com/HarlonWang/loginbase-kt)（第 4 步新建）。**协议契约 [docs/protocol.md](docs/protocol.md) 只住本仓，是两端的唯一权威。**

## 由来

- 起点是 TrendingAI 替换 Logto 的调研（邮箱登录被迫走托管 web 页、CN 链路差），结论选定自建，见 [docs/logto-替换方案-调研.md](docs/logto-替换方案-调研.md)
- 服务端实现的母本是 Tono-Server 已在生产验证的邮箱验证码登录（含全套测试），本仓库是它的抽取 + 泛化
- 路线选择（公共库而非中心化服务）与仓库设计见 [docs/design.md](docs/design.md)，命名记录见 [docs/naming.md](docs/naming.md)

## 结构（两个仓库：一份协议，两个产物）

```
loginbase/                   # 本仓：TS 服务端库 + 协议契约
├── src/                     # TS 服务端库（Hono sub-app 工厂），从 Tono-Server 平移
├── test/                    # vitest
├── docs/
│   ├── design.md            # 路线与仓库设计决策
│   ├── server-design.md     # 服务端技术方案（公共 API/协议草案/会话模型/平移策略）
│   ├── plan.md              # 实施计划（五步任务清单/验收点/版本线）
│   ├── naming.md            # 命名讨论记录
│   ├── protocol.md          # API 契约（唯一权威）——代码平移时落笔
│   └── logto-替换方案-调研.md # 背景调研（自 TrendingProjects 迁入）
└── README.md

loginbase-kt/                # 姊妹仓：KMP 客户端库（独立 gradle 工程、独立 CI 与版本线）
```

## 产物坐标

```
服务端仓     HarlonWang/loginbase          （含 protocol.md，协议唯一权威）
客户端仓     HarlonWang/loginbase-kt
npm         loginbase                     （npm registry，本仓 tag 触发 CI 发布）
Maven       wang.harlon:loginbase-kt      （Maven Central，客户端仓 tag 触发 CI 发布）
Kotlin 包    wang.harlon.loginbase
```

两仓各自独立版本线，tag 为裸版本号；协议兼容关系由 `protocol.md` 版本历史 + 客户端仓 README 的对齐声明表达，不靠版本号相等表达。

## 状态与路线

**落地第 1~3 步已完成**（2026-08-13）：`loginbase@1.1.0` 上线 npm；Tono-Server（钩子化）与 github-ai-trending-api（双轨迁移：loginbase 优先 + Logto fallback）均已部署生产并通过分层验收。下一步 = 第 4 步 KMP 客户端。落地顺序：

1. 从 Tono-Server 平移服务端代码与测试，Tono-Server 改为依赖本包（其现有测试即抽取验收）
2. 钩子化（`onVerified` 用户回调）+ zh/en 邮件模板 + github-oauth 可选插件
3. TrendingAI 后端接入（`/auth` 挂载 + requireAuth 双轨 + Logto 存量迁移）
4. KMP 客户端库 + TrendingAI 登录 UI（commonMain）
5. Tono-Android 择机换用 loginbase-kt 的 android target

## 设计红线

- 依赖最小集：服务端 hono + jose（+ zod-validator），客户端 ktor + kotlinx-serialization + multiplatform-settings。auth 库是供应链攻击的最高价值目标，每加一个依赖都要过一遍这个念头
- 协议变更：服务端实现 + `docs/protocol.md` 同一个 commit，并在 `loginbase-kt` 仓开跟进 issue，客户端版本落地前不关（2026-08-13 由 monorepo 三位一体改判，理由见 design.md）
