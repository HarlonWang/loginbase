// github-oauth 可选插件（协议见 docs/protocol.md「GitHub OAuth」节）。
// 设计目标：token 永不进 URL——callback 只回跳一次性授权码（otc），
// 客户端再以 POST /oauth/exchange 兑换 token 对。
import type { Hono } from "hono";
import type { LoginConfig, GithubSocialConfig } from "../config.js";
import { trimmedField } from "../body.js";
import { createAuthMiddleware, type AuthVariables } from "../middleware.js";
import { generateRefreshToken as randomToken } from "../session.js";
import { createSession } from "../session.js";
import { createTracker } from "../stats.js";
import { signAccessToken, ACCESS_TTL_SECONDS } from "../token.js";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_API_USER = "https://api.github.com/user";
const GITHUB_API_EMAILS = "https://api.github.com/user/emails";

const STATE_TTL_SECONDS = 600;
const OTC_TTL_SECONDS = 60;
const DEFAULT_SCOPE = "user:email";

// App 自定义的冲突 reason 会进回跳 URL，限制字符集防畸形/敏感内容外泄
const REASON_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

interface StateRecord {
  redirect: string;
  /**
   * "link" = 已登录用户绑定第二身份；缺省 = 登录/注册。
   * 显式字段而非靠 userId 是否存在推断——将来加别的流程不用改判定。
   */
  mode?: "link";
  /** mode==="link" 时的当前用户（来自 link/start 的 Bearer 校验） */
  userId?: string;
  /**
   * 统计用的流程标识（docs/stats-design.md）：串联 start → callback → exchange，
   * 使「服务端签发了但客户端从未兑换」（回跳丢失）能精确配对而非两个计数相减。
   * **与 state / otc 是两回事**——那两个是单次凭证，绝不能写进长期保存的统计表。
   */
  flowId?: string;
}

/** 兑换后**返回给客户端**的载荷——形态即协议，加字段等于改协议 */
interface OtcPayload {
  accessToken: string;
  refreshToken: string;
  isNewUser?: boolean;
  user?: unknown;
}

/**
 * **存进 KV** 的载荷 = 协议载荷 + 只供服务端统计的字段。
 * 两个类型分开是为了让「统计字段必须在兑换时剥离」由类型表达，而不只靠一条测试——
 * 谁往这里加字段而忘了解构，泄的就是响应体。
 */
interface OtcStoredPayload extends OtcPayload {
  /** 登录成功事件要记「谁登录了」，而 exchange 端点本身无从得知，故随载荷带下来 */
  userId?: string;
  flowId?: string;
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

function buildAuthorizeUrl(
  gh: GithubSocialConfig,
  callbackUrl: string,
  state: string
): string {
  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set("client_id", gh.clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", gh.scope ?? DEFAULT_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

interface GithubIdentity {
  ghUser: { id: number } & Record<string, unknown>;
  ghToken: string;
  /** primary+verified 优先，退而求其次任一 verified；一个都没有则缺省 */
  email?: string;
  /** 全部 verified 邮箱，归一化小写 */
  verifiedEmails: string[];
}

/**
 * 换 token → 取用户 → 取邮箱。login 与 link 两条流程共用（callback 是同一个端点：
 * GitHub OAuth App 的回调地址注册在 GitHub 侧，多一个即多一处配置漂移）。
 * 返回 null = 换码或取用户失败，调用方回跳 oauth_failed。
 */
async function fetchGithubIdentity(
  gh: GithubSocialConfig,
  code: string
): Promise<GithubIdentity | null> {
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
  if (!ghToken) return null;

  // GitHub API 要求 User-Agent
  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "loginbase",
  };
  const userRes = await fetch(GITHUB_API_USER, { headers: ghHeaders });
  if (!userRes.ok) return null;
  const ghUser = (await userRes.json()) as { id: number } & Record<string, unknown>;

  const emailsRes = await fetch(GITHUB_API_EMAILS, { headers: ghHeaders });
  const emails = emailsRes.ok
    ? ((await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>)
    : [];
  const normalize = (e: string) => e.trim().toLowerCase();
  const verifiedEmails = emails.filter((e) => e.verified).map((e) => normalize(e.email));
  const email =
    emails.find((e) => e.primary && e.verified)?.email ??
    emails.find((e) => e.verified)?.email;

  return {
    ghUser,
    ghToken,
    ...(email ? { email: normalize(email) } : {}),
    verifiedEmails,
  };
}

export function registerGithubOauth<TEnv>(
  auth: Hono<{ Variables: AuthVariables }>,
  getConfig: (env: TEnv) => LoginConfig,
  basePath: string
) {
  const cfg = (c: { env: unknown }) => getConfig(c.env as TEnv);
  const github = (c: { env: unknown }) => cfg(c).socials?.github;
  const authMiddleware = createAuthMiddleware(getConfig);
  const track = createTracker(getConfig);
  const callbackUrlFor = (c: { env: unknown; req: { url: string } }, gh: GithubSocialConfig) =>
    gh.callbackUrl ??
    `${new URL(c.req.url).origin}${basePath}/oauth/github/callback`;

  auth.get("/oauth/github/start", async (c) => {
    const gh = github(c);
    if (!gh) return c.json({ error: "not_configured" }, 404);

    const redirect = c.req.query("redirect") ?? "";
    if (!redirect || !redirectAllowed(redirect, gh)) {
      track(c, {
        event: "oauth_start",
        outcome: "invalid_redirect",
        provider: "github",
      });
      return c.json({ error: "invalid_redirect" }, 400);
    }

    const state = randomToken();
    const flowId = crypto.randomUUID();
    const record: StateRecord = { redirect, flowId };
    await cfg(c).kv.put(`oauth:state:${state}`, JSON.stringify(record), {
      expirationTtl: STATE_TTL_SECONDS,
    });

    track(c, { event: "oauth_start", outcome: "ok", provider: "github", flowId });
    return c.redirect(buildAuthorizeUrl(gh, callbackUrlFor(c, gh), state), 302);
  });

  // 已登录用户绑定第二身份。**必须是 POST**：浏览器导航带不了 Authorization 头，
  // 故不能像 login 那样 GET 直接 302——客户端先换 authorizeUrl，再自己打开浏览器。
  auth.post("/oauth/github/link/start", authMiddleware, async (c) => {
    const gh = github(c);
    // onLinked 未提供 = 该能力未启用（默认关闭、显式启用）
    if (!gh || !cfg(c).onLinked) return c.json({ error: "not_configured" }, 404);

    const body = await c.req
      .json<{ redirect?: string }>()
      .catch(() => ({}) as { redirect?: string });
    const redirect = trimmedField(body.redirect);
    if (!redirect || !redirectAllowed(redirect, gh)) {
      track(c, {
        event: "oauth_start",
        outcome: "invalid_redirect",
        provider: "github",
        meta: { mode: "link" },
      });
      return c.json({ error: "invalid_redirect" }, 400);
    }

    const state = randomToken();
    const flowId = crypto.randomUUID();
    const record: StateRecord = {
      redirect,
      mode: "link",
      userId: c.get("userId"),
      flowId,
    };
    await cfg(c).kv.put(`oauth:state:${state}`, JSON.stringify(record), {
      expirationTtl: STATE_TTL_SECONDS,
    });

    track(c, {
      event: "oauth_start",
      outcome: "ok",
      provider: "github",
      userId: c.get("userId"),
      flowId,
      meta: { mode: "link" },
    });
    return c.json(
      { authorizeUrl: buildAuthorizeUrl(gh, callbackUrlFor(c, gh), state) },
      200
    );
  });

  auth.get("/oauth/github/callback", async (c) => {
    const gh = github(c);
    if (!gh) return c.json({ error: "not_configured" }, 404);

    const code = c.req.query("code") ?? "";
    const providerError = c.req.query("error") ?? "";
    const state = c.req.query("state") ?? "";
    const stateKey = `oauth:state:${state}`;
    const rawState = state ? await cfg(c).kv.get(stateKey) : null;
    if (!rawState) {
      // state 无效即回跳地址不可信，只能就地报错。
      // 此分支拿不到 flowId——它就存在读不出来的那条 state 记录里。
      track(c, {
        event: "oauth_callback",
        outcome: "invalid_state",
        provider: "github",
      });
      return c.json({ error: "invalid_state" }, 400);
    }
    await cfg(c).kv.delete(stateKey); // 单次使用，验证即焚
    const { redirect, mode, userId, flowId } = JSON.parse(rawState) as StateRecord;
    const trackCallback = (outcome: string, meta?: Record<string, unknown>) =>
      track(c, {
        event: "oauth_callback",
        outcome,
        provider: "github",
        ...(flowId ? { flowId } : {}),
        ...(userId ? { userId } : {}),
        meta: { mode: mode ?? "login", ...meta },
      });

    // GitHub 用 ?error= 回报用户拒绝授权，此时没有 code；state 已验过，回跳地址可信
    if (!code) {
      const reason = REASON_PATTERN.test(providerError) ? providerError : "no_code";
      trackCallback(reason);
      return c.redirect(withParam(redirect, "error", reason), 302);
    }

    const identity = await fetchGithubIdentity(gh, code);
    if (!identity) {
      trackCallback("oauth_failed");
      return c.redirect(withParam(redirect, "error", "oauth_failed"), 302);
    }
    const { ghUser, ghToken, email, verifiedEmails } = identity;

    const userAgent = c.req.header("User-Agent") ?? undefined;
    const ip = c.req.header("CF-Connecting-IP") ?? undefined;
    const common = {
      provider: "github" as const,
      providerUserId: String(ghUser.id),
      providerProfile: publicProfile(ghUser), // GitHub /user 公开档案白名单字段
      providerAccessToken: ghToken,
      verifiedEmails,
      requestMeta: { ip, userAgent },
    };

    // ---- link 分支：认领身份，不建会话、不发 token ----
    if (mode === "link") {
      const onLinked = cfg(c).onLinked;
      // userId 由 link/start 写入，缺失只可能是载荷被篡改/降级，保守失败
      if (!onLinked || !userId) {
        trackCallback("internal");
        return c.redirect(withParam(redirect, "error", "internal"), 302);
      }
      let result;
      try {
        // email 在此可缺省：userId 已定，邮箱只是附加信息（与 login 分支的关键差别）
        result = await onLinked({ userId, ...common, ...(email ? { email } : {}) });
      } catch {
        trackCallback("internal");
        return c.redirect(withParam(redirect, "error", "internal"), 302);
      }
      if (!result.ok) {
        const reason = REASON_PATTERN.test(result.reason) ? result.reason : "internal";
        // 冲突原因分布是消费方业务规则的体检表（E2）
        trackCallback("link_conflict", { reason });
        return c.redirect(withParam(redirect, "error", reason), 302);
      }
      trackCallback("linked");
      return c.redirect(withParam(redirect, "linked", "github"), 302);
    }

    // ---- login 分支：email 是账号锚点，缺了就无法找号建号 ----
    if (!email) {
      trackCallback("no_email");
      return c.redirect(withParam(redirect, "error", "oauth_no_email"), 302);
    }

    let verified;
    try {
      verified = await cfg(c).onVerified({ email, ...common });
    } catch {
      trackCallback("internal");
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
    const payload: OtcStoredPayload = {
      accessToken,
      refreshToken,
      ...(verified.isNewUser !== undefined ? { isNewUser: verified.isNewUser } : {}),
      ...(verified.user !== undefined ? { user: verified.user } : {}),
      userId: verified.userId,
      ...(flowId ? { flowId } : {}),
    };
    await cfg(c).kv.put(`oauth:otc:${otc}`, JSON.stringify(payload), {
      expirationTtl: OTC_TTL_SECONDS,
    });

    // 服务端签发成功 ≠ 登录成功：客户端可能永远收不到这次回跳（回跳丢失 = D11）
    track(c, {
      event: "oauth_callback",
      outcome: "issued",
      provider: "github",
      userId: verified.userId,
      ...(flowId ? { flowId } : {}),
      ...(verified.isNewUser !== undefined ? { isNewUser: verified.isNewUser } : {}),
      meta: { mode: "login" },
    });
    return c.redirect(withParam(redirect, "otc", otc), 302);
  });

  auth.post("/oauth/exchange", async (c) => {
    const gh = github(c);
    if (!gh) return c.json({ error: "not_configured" }, 404);

    const body = await c.req
      .json<{ otc?: string }>()
      .catch(() => ({} as { otc?: string }));
    const otc = trimmedField(body.otc);
    const key = `oauth:otc:${otc}`;
    const raw = otc ? await cfg(c).kv.get(key) : null;
    if (!raw) {
      // otc 过期（60s）或已被兑换；与「回跳压根没到达」是两回事，故分开记
      track(c, {
        event: "oauth_exchange",
        outcome: "invalid_otc",
        provider: "github",
      });
      return c.json({ error: "invalid_otc" }, 400);
    }
    await cfg(c).kv.delete(key); // 单次使用，兑换即焚

    // 解构即剥离：payload 的类型收窄回 OtcPayload，统计字段进不了响应体
    const { userId, flowId, ...payload } = JSON.parse(raw) as OtcStoredPayload;
    const trace = {
      ...(userId ? { userId } : {}),
      ...(flowId ? { flowId } : {}),
    };
    track(c, {
      event: "oauth_exchange",
      outcome: "ok",
      provider: "github",
      ...trace,
    });
    // 「登录成功」的口径落点在此而非 callback：这里才是客户端真正拿到 token 对的时刻。
    // 顺带一个好处：此处的 country 来自客户端自己的网络，而非浏览器（授权页往往
    // 挂着代理），比 callback 的国家更接近用户真实位置。
    track(c, {
      event: "login",
      provider: "github",
      ...trace,
      ...(payload.isNewUser !== undefined ? { isNewUser: payload.isNewUser } : {}),
    });

    return c.json(payload, 200);
  });
}
