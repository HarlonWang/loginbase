# loginbase

> 为 Cloudflare Workers 而生的邮箱验证码登录、社交登录与会话管理。

[English](README.md) | **简体中文**

[![npm](https://img.shields.io/npm/v/loginbase)](https://www.npmjs.com/package/loginbase)
[![license](https://img.shields.io/npm/l/loginbase)](LICENSE)

loginbase 挂进你已经在跑的 Worker。用户、会话、登录事件全部落在**你自己的** D1 里——没有中心化账号服务，没有厂商后台，也不需要额外部署任何东西。官方 Kotlin Multiplatform 客户端 [loginbase-kt](https://github.com/HarlonWang/loginbase-kt) 负责另一半。

## 为什么

**托管方案要你交出体验和数据。** 邮箱登录被迫跳去别人的 web 页，延迟取决于别人的边缘节点，用户身份存在别人的数据库里——等哪天定价或政策一变，这就是一个迁移项目。

**自己写又比看上去难。** refresh 轮换、重放检测、回执丢包与客户端重试之间的竞态、十几个在飞请求同时刷新……任何一条写错都是**静默失败**：测试期间什么都不会坏，等到用户莫名其妙被登出你才发现，或者根本发现不了。

loginbase 是中间那条路：一套成熟认证产品该有的会话模型，以你自己持有的依赖形态交付，跑在你已经有的那个 Worker 里。

## 能力

- **不止一种无密码登录。** 六位邮箱验证码（防账号枚举的响应 + 三层限流）、GitHub OAuth，以及身份绑定——已登录用户认领第二身份，而不是稀里糊涂多出一个重复账号。验证码邮件内置中英文。
- **盗用会被发现，弱网不会被误伤。** refresh token 每次使用即轮换，重放即当场终止会话；而弱网丢掉的那次回执**不算**盗用，会被救活而不是被惩罚。
- **过得了应用商店审核。** 无密码登录交不出 Google Play 与 App Store Connect 要的静态凭据，可选的演示账号能——且不开任何鉴权旁路。
- **内建登录统计。** 发码、验证、刷新、注销逐条落进你自己的 `auth_events` 表，地理信息取自 `request.cf`——零外部依赖，数据不出你的账号。
- **一个把 token 彻底藏起来的客户端。** 用 [loginbase-kt](https://github.com/HarlonWang/loginbase-kt)，你的 App 代码里不会出现 token、刷新调用或 401 处理。

## 快速开始

**1. 安装。** Hono 作为 peer dependency 自动带上——你的 Worker 若已经在用它，那就是同一份，版本由你定。

```bash
npm install loginbase
```

**2. 执行迁移。** DDL（`sessions`、`auth_events`）随包分发。

```toml
# wrangler.toml —— 用一个专供认证的 D1 时
[[d1_databases]]
binding = "DB"
database_name = "my-app"
database_id = "..."
migrations_dir = "node_modules/loginbase/migrations"
```

```bash
npx wrangler d1 migrations apply my-app --remote
```

如果共用一个已有自己迁移的 D1，改为把 `node_modules/loginbase/migrations/` 下的两个文件复制进你自己的迁移目录。**漏掉 `0002_auth_events.sql` 是静默的**——登录照常工作，只是统计永远不落库。

**3. 建实例并挂载。** loginbase 只要求你一件事：把一个已验证的身份换成 userId。用户表的一切仍然归你。

```ts
import { Hono } from "hono";
import { createLogin } from "loginbase";

const login = createLogin<Env>((env) => ({
  db: env.DB,
  kv: env.EMAIL_CODES,
  jwt: { secret: env.JWT_SECRET },
  email: {
    resendApiKey: env.RESEND_API_KEY,
    from: "Acme <login@acme.com>",
    brand: "Acme",
  },
  async onVerified({ email }) {
    const user = await findOrCreateUser(env.DB, email);
    return { userId: user.id, isNewUser: user.isNew };
  },
}));

const app = new Hono<{ Bindings: Env }>();
app.route("/", login.app);                        // 提供 /auth/*
app.get("/api/me", login.middleware, (c) =>       // Bearer 校验
  c.json({ userId: c.get("userId") })
);

export default app;
```

自己的路由没用 Hono？把 `login.fetch(request, env, ctx)` 放在一个 `pathname.startsWith("/auth")` 后面，效果相同。

**4. 加上 GitHub 登录**（可选）——把 OAuth 应用凭据和允许回跳的 deep link 交给 loginbase：

```ts
socials: {
  github: {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    allowedRedirects: ["acme://auth"],
  },
},
```

**5. 接上你的 App。** 把 [loginbase-kt](https://github.com/HarlonWang/loginbase-kt) 指向 `https://your-worker.example.com/auth` 就完事了——存储、刷新、OAuth 的浏览器往返都归它。

## 两端如何对上

同一个 redirect 要在三处保持一致，否则社交登录会以很难查的方式失败：

| 位置 | 取值 |
|---|---|
| 服务端 | `socials.github.allowedRedirects` |
| Android App | `manifestPlaceholders["loginbaseRedirectScheme"]` |
| 客户端运行时 | 由同一个占位符推导 |

客户端能直接打印该填什么——调 `Loginbase.redirectUri(context)`，把结果粘进 `allowedRedirects`。

## 运行要求

Cloudflare Workers，带 D1 与 KV binding · `hono` ^4.12.8 · 一个用于投递的 [Resend](https://resend.com) 账号。

## 不包含什么

loginbase 刻意止步于认证与会话：没有密码登录，没有 OIDC / SAML，没有多租户，没有管理后台，也不存用户档案——用户表归你的 `onVerified` 管。登录方式只有邮箱与 GitHub，邮件只走 Resend，运行时只有 Cloudflare Workers。如果你要的是一个身份提供商而不是一个登录底座，请去用身份提供商。

## 文档

| | |
|---|---|
| [协议契约](docs/protocol.md) | wire API——两端的唯一权威 |
| [服务端设计](docs/server-design.md) | 配置面、会话模型、钩子 |
| [邮箱与身份](docs/email-identity.md) | **接入前必读**——为什么邮箱不适合当身份锚点 |
| [登录统计](docs/stats-design.md) | 事件模型与指标口径 |
| [设计决策](docs/design.md) | 为什么是库而不是服务，以及那些没走的路 |

## License

MIT
