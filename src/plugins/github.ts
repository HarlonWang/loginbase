// github-oauth 可选插件（协议见 docs/protocol.md「GitHub OAuth」节）。
// 设计目标：token 永不进 URL——callback 只回跳一次性授权码（otc），
// 客户端再以 POST /oauth/exchange 兑换 token 对。
import type { Hono } from "hono";
import type { LoginConfig, GithubSocialConfig } from "../config.js";
import type { AuthVariables } from "../middleware.js";
import { generateRefreshToken as randomToken } from "../session.js";
import { createSession } from "../session.js";
import { signAccessToken, ACCESS_TTL_SECONDS } from "../token.js";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_API_USER = "https://api.github.com/user";
const GITHUB_API_EMAILS = "https://api.github.com/user/emails";

const STATE_TTL_SECONDS = 600;
const OTC_TTL_SECONDS = 60;

interface StateRecord {
  redirect: string;
}

interface OtcPayload {
  accessToken: string;
  refreshToken: string;
  isNewUser?: boolean;
  user?: unknown;
}

// 结构化校验而非字符串前缀：startsWith("https://example.com") 会被
// https://example.com.evil.com 绕过（开放重定向 → otc 泄露给攻击者域）。
// scheme + host 精确匹配，path 只允许白名单条目的前缀扩展。
function redirectAllowed(redirect: string, github: GithubSocialConfig): boolean {
  let target: URL;
  try {
    target = new URL(redirect);
  } catch {
    return false;
  }
  return github.allowedRedirects.some((allowed) => {
    let base: URL;
    try {
      base = new URL(allowed);
    } catch {
      return false;
    }
    return (
      target.protocol === base.protocol &&
      target.host === base.host &&
      target.pathname.startsWith(base.pathname)
    );
  });
}

function withParam(url: string, key: string, value: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

// providerProfile 只透传建档需要的公开档案白名单——GET /user 的认证视图含
// two_factor_authentication、私有仓库统计等敏感字段，不该流出库边界。
const PROFILE_FIELDS = [
  "id",
  "login",
  "name",
  "email",
  "avatar_url",
  "bio",
  "html_url",
  "company",
  "location",
  "blog",
  "twitter_username",
  "created_at",
] as const;

function publicProfile(user: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PROFILE_FIELDS) {
    if (user[key] !== undefined) out[key] = user[key];
  }
  return out;
}

export function registerGithubOauth<TEnv>(
  auth: Hono<{ Variables: AuthVariables }>,
  getConfig: (env: TEnv) => LoginConfig,
  basePath: string
) {
  const cfg = (c: { env: unknown }) => getConfig(c.env as TEnv);
  const github = (c: { env: unknown }) => cfg(c).socials?.github;

  auth.get("/oauth/github/start", async (c) => {
    const gh = github(c);
    if (!gh) return c.json({ error: "not_configured" }, 404);

    const redirect = c.req.query("redirect") ?? "";
    if (!redirect || !redirectAllowed(redirect, gh)) {
      return c.json({ error: "invalid_redirect" }, 400);
    }

    const state = randomToken();
    const record: StateRecord = { redirect };
    await cfg(c).kv.put(`oauth:state:${state}`, JSON.stringify(record), {
      expirationTtl: STATE_TTL_SECONDS,
    });

    const callbackUrl =
      gh.callbackUrl ??
      `${new URL(c.req.url).origin}${basePath}/oauth/github/callback`;
    const url = new URL(GITHUB_AUTHORIZE);
    url.searchParams.set("client_id", gh.clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("scope", "user:email");
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  auth.get("/oauth/github/callback", async (c) => {
    const gh = github(c);
    if (!gh) return c.json({ error: "not_configured" }, 404);

    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const stateKey = `oauth:state:${state}`;
    const rawState = state ? await cfg(c).kv.get(stateKey) : null;
    if (!code || !rawState) {
      // state 无效即回跳地址不可信，只能就地报错
      return c.json({ error: "invalid_state" }, 400);
    }
    await cfg(c).kv.delete(stateKey); // 单次使用，验证即焚
    const { redirect } = JSON.parse(rawState) as StateRecord;

    // server-side 换 token：client_secret 只在此出现，客户端不可见
    const tokenRes = await fetch(GITHUB_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: gh.clientId,
        client_secret: gh.clientSecret,
        code,
      }),
    });
    const tokenBody = tokenRes.ok
      ? ((await tokenRes.json().catch(() => null)) as { access_token?: string } | null)
      : null;
    const ghToken = tokenBody?.access_token;
    if (!ghToken) return c.redirect(withParam(redirect, "error", "oauth_failed"), 302);

    // GitHub API 要求 User-Agent
    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "loginbase",
    };
    const userRes = await fetch(GITHUB_API_USER, { headers: ghHeaders });
    if (!userRes.ok) return c.redirect(withParam(redirect, "error", "oauth_failed"), 302);
    const ghUser = (await userRes.json()) as { id: number } & Record<string, unknown>;

    const emailsRes = await fetch(GITHUB_API_EMAILS, { headers: ghHeaders });
    const emails = emailsRes.ok
      ? ((await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>)
      : [];
    const email =
      emails.find((e) => e.primary && e.verified)?.email ??
      emails.find((e) => e.verified)?.email;
    if (!email) return c.redirect(withParam(redirect, "error", "oauth_no_email"), 302);

    const userAgent = c.req.header("User-Agent") ?? undefined;
    const ip = c.req.header("CF-Connecting-IP") ?? undefined;

    let verified;
    try {
      verified = await cfg(c).onVerified({
        email: email.trim().toLowerCase(),
        provider: "github",
        providerUserId: String(ghUser.id),
        providerProfile: publicProfile(ghUser), // GitHub /user 公开档案白名单字段
        requestMeta: { ip, userAgent },
      });
    } catch {
      return c.redirect(withParam(redirect, "error", "internal"), 302);
    }

    const refreshTtlMs = cfg(c).session?.refreshTtlMs ?? null;
    const { sessionId, refreshToken } = await createSession(cfg(c).db, {
      userId: verified.userId,
      userAgent,
      ip,
      expiresAt: refreshTtlMs == null ? null : Date.now() + refreshTtlMs,
    });
    const accessToken = await signAccessToken(
      cfg(c).jwt.secret,
      verified.userId,
      sessionId,
      cfg(c).jwt.accessTtlSeconds ?? ACCESS_TTL_SECONDS
    );

    const otc = randomToken();
    const payload: OtcPayload = {
      accessToken,
      refreshToken,
      ...(verified.isNewUser !== undefined ? { isNewUser: verified.isNewUser } : {}),
      ...(verified.user !== undefined ? { user: verified.user } : {}),
    };
    await cfg(c).kv.put(`oauth:otc:${otc}`, JSON.stringify(payload), {
      expirationTtl: OTC_TTL_SECONDS,
    });

    return c.redirect(withParam(redirect, "otc", otc), 302);
  });

  auth.post("/oauth/exchange", async (c) => {
    const gh = github(c);
    if (!gh) return c.json({ error: "not_configured" }, 404);

    const body = await c.req
      .json<{ otc?: string }>()
      .catch(() => ({} as { otc?: string }));
    const otc = (body.otc ?? "").trim();
    const key = `oauth:otc:${otc}`;
    const raw = otc ? await cfg(c).kv.get(key) : null;
    if (!raw) return c.json({ error: "invalid_otc" }, 400);
    await cfg(c).kv.delete(key); // 单次使用，兑换即焚

    return c.json(JSON.parse(raw) as OtcPayload, 200);
  });
}
