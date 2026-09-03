# loginbase

> Email OTP, social sign-in and session management for Cloudflare Workers.

**English** | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/loginbase)](https://www.npmjs.com/package/loginbase)
[![license](https://img.shields.io/npm/l/loginbase)](LICENSE)

loginbase mounts into a Worker you already run. Users, sessions and login events live in **your** D1 database — there is no central account server, no vendor dashboard, and nothing extra to deploy. An official Kotlin Multiplatform client, [loginbase-kt](https://github.com/HarlonWang/loginbase-kt), implements the other half.

## Why

**Hosted auth costs you the experience and the data.** Email sign-in gets redirected to someone else's web page, latency depends on someone else's edge, and your users' identities sit in someone else's database — which turns into a migration project the day pricing or policy changes.

**Rolling your own is harder than it looks.** Refresh rotation, replay detection, the race between a dropped refresh response and the client's retry, a dozen in-flight requests all refreshing at once. Get any of these wrong and it fails *silently*: nothing breaks in testing, and you find out when users are logged out for no reason — or you never find out at all.

loginbase is the middle path. The session model of a real auth product, shipped as a dependency you own, running inside the Worker you already have.

## What you get

- **Passwordless sign-in, more than one way.** Six-digit email codes with enumeration-safe responses and three layers of rate limiting, GitHub OAuth, and account linking — so a signed-in user claims a second identity instead of ending up with a duplicate account. Code emails ship in English and Chinese.
- **Token theft is detected; bad networks aren't punished.** Refresh tokens rotate on every use, and a replayed token kills the session on the spot. A refresh response lost to a flaky connection is *not* theft, and gets recovered rather than punished.
- **Passes app-store review.** Passwordless login can't produce the static credentials Google Play and App Store Connect ask for. An optional demo account can, without opening an authentication bypass.
- **Login analytics built in.** Every send, verify, refresh and revoke lands in your own `auth_events` table, with geography from `request.cf` — no external dependency, no data leaving your account.
- **A client that hides tokens entirely.** With [loginbase-kt](https://github.com/HarlonWang/loginbase-kt), your app code never contains a token, a refresh call, or a 401 handler.

## Quick start

**1. Install.** Hono comes along as a peer dependency — if your Worker already uses it, that stays the single copy and the version is yours to pick.

```bash
npm install loginbase
```

**2. Apply the migrations.** The package ships its own DDL (`sessions`, `auth_events`).

```toml
# wrangler.toml — for a D1 database dedicated to auth
[[d1_databases]]
binding = "DB"
database_name = "my-app"
database_id = "..."
migrations_dir = "node_modules/loginbase/migrations"
```

```bash
npx wrangler d1 migrations apply my-app --remote
```

Sharing a D1 that already has migrations of its own? Copy the two files from `node_modules/loginbase/migrations/` into your own migrations directory instead. **Skipping `0002_auth_events.sql` is silent** — login keeps working, analytics just never land.

**3. Create and mount.** The only thing loginbase asks of you is how to turn a verified identity into a user id. Everything about your user table stays yours.

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
app.route("/", login.app);                        // serves /auth/*
app.get("/api/me", login.middleware, (c) =>       // Bearer verification
  c.json({ userId: c.get("userId") })
);

export default app;
```

Not using Hono for your own routes? `login.fetch(request, env, ctx)` behind one `pathname.startsWith("/auth")` works the same.

**4. Add GitHub sign-in** (optional) by giving loginbase your OAuth app and the deep links it's allowed to return to:

```ts
socials: {
  github: {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    allowedRedirects: ["acme://auth"],
  },
},
```

**5. Connect your app.** Point [loginbase-kt](https://github.com/HarlonWang/loginbase-kt) at `https://your-worker.example.com/auth` and you're done — it owns storage, refresh and the OAuth browser round trip from there.

## How the two halves line up

One redirect value has to match in three places, or social sign-in fails in ways that are tedious to diagnose:

| Where | What |
|---|---|
| Server | `socials.github.allowedRedirects` |
| Android app | `manifestPlaceholders["loginbaseRedirectScheme"]` |
| Client runtime | derived from that same placeholder |

The client can print exactly what to whitelist — call `Loginbase.redirectUri(context)` and paste the result into `allowedRedirects`.

## Requirements

Cloudflare Workers with D1 and KV bindings · `hono` ^4.12.8 · a [Resend](https://resend.com) account for delivery.

**The zone the Worker runs on must have no cache rule that makes third-party subrequests cacheable.** loginbase's GitHub sign-in calls `api.github.com/user` with the user's token as a Worker subrequest, and subrequests inherit the zone's Cache Rules. A "Cache everything" rule on that zone caches the response by URL and serves one user's profile to the next — cross-account sign-in. Keep the zone at zero cache rules; a disabled rule does not count. Details and detection in [Cache safety](docs/cache-safety.md).

## Not included

loginbase deliberately stops at authentication and sessions. It has no password login, no OIDC or SAML, no multi-tenancy, no admin UI, and no user profile storage — your `onVerified` owns the user table. Sign-in providers are email and GitHub; email delivery is Resend; the runtime is Cloudflare Workers. If you need an identity provider rather than a login foundation, use one.

## Documentation

| | |
|---|---|
| [Protocol contract](docs/protocol.md) | The wire API — single source of truth for both halves |
| [Server design](docs/server-design.md) | Configuration surface, session model, hooks |
| [Cache safety](docs/cache-safety.md) | **Read before deploying** — why the zone must have no cache rules |
| [Email and identity](docs/email-identity.md) | **Read before integrating** — why an email address is a poor identity anchor |
| [Login analytics](docs/stats-design.md) | Event schema and metric definitions |
| [Design decisions](docs/design.md) | Why a library instead of a service, and other roads not taken |

## License

MIT
