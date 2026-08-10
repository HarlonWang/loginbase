# loginbase

> The shared login foundation for my apps — email OTP + social OAuth + session management.
> Cloudflare Workers server library + Kotlin Multiplatform client.

多 App 共用的登录底座：邮箱验证码登录、社交 OAuth（GitHub 等）、会话管理（refresh 轮换 + 重用检测 + 丢回执救活）。服务端库跑在各 App 自己的 Cloudflare Worker 里（数据在各自 D1，不做中心化账号），客户端库以 Kotlin Multiplatform 提供。

## 由来

- 起点是 TrendingAI 替换 Logto 的调研（邮箱登录被迫走托管 web 页、CN 链路差），结论选定自建，见 [docs/logto-替换方案-调研.md](docs/logto-替换方案-调研.md)
- 服务端实现的母本是 Tono-Server 已在生产验证的邮箱验证码登录（含全套测试），本仓库是它的抽取 + 泛化
- 路线选择（公共库而非中心化服务）与仓库设计见 [docs/design.md](docs/design.md)，命名记录见 [docs/naming.md](docs/naming.md)

## 结构（monorepo：一份协议，两个产物）

```
loginbase/
├── src/                     # TS 服务端库（Hono sub-app 工厂），从 Tono-Server 平移
├── test/                    # vitest
├── kotlin/                  # KMP 客户端库（独立 gradle 工程）
├── docs/
│   ├── design.md            # 路线与仓库设计决策
│   ├── naming.md            # 命名讨论记录
│   ├── protocol.md          # API 契约（唯一权威）——代码平移时落笔
│   └── logto-替换方案-调研.md # 背景调研（自 TrendingProjects 迁入）
└── README.md
```

## 产物坐标

```
仓库        HarlonWang/loginbase
npm         @harlonwang/loginbase        （npm registry，tag 触发 CI 发布）
Maven       wang.harlon:loginbase-kt     （Maven Central，tag 触发 CI 发布）
Kotlin 包    wang.harlon.loginbase
```

## 状态与路线

当前为**骨架阶段**（仅文档）。落地顺序：

1. 从 Tono-Server 平移服务端代码与测试，Tono-Server 改为依赖本包（其现有测试即抽取验收）
2. 钩子化（`onVerified` 用户回调）+ zh/en 邮件模板 + github-oauth 可选插件
3. TrendingAI 后端接入（`/auth` 挂载 + requireAuth 双轨 + Logto 存量迁移）
4. KMP 客户端库 + TrendingAI 登录 UI（commonMain）
5. Tono-Android 择机换用 loginbase-kt 的 android target

## 设计红线

- 依赖最小集：服务端 hono + jose（+ zod-validator），客户端 ktor + kotlinx-serialization + multiplatform-settings。auth 库是供应链攻击的最高价值目标，每加一个依赖都要过一遍这个念头
- 协议变更必须服务端 + 客户端 + `docs/protocol.md` 同一个 commit；单一版本线，一个 tag 同时锁定两端
