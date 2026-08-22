// 母本为 Tono-Server src/auth/handler.ts（第 1 步平移）；第 2 步钩子化：
// 用户语义（users upsert / 试用 / /me）经 onVerified 移回 App 侧，
// 事件出口接 onEvent，refreshTtlMs / accessTtlSeconds 可配生效。
import { Hono } from "hono";
import {
  generateCode,
  storeCode,
  readCode,
  deleteCode,
  incrementAttempts,
  MAX_ATTEMPTS,
} from "./code.js";
import {
  sendCodeEmail,
  resolveEmailLocale,
  warnEmailConfigOnce,
} from "./email.js";
import { checkSendRateLimit, recordSend } from "./rate_limit.js";
import {
  createSession,
  hashRefreshToken,
  findSession,
  rotateSession,
  revokeFamily,
  tryRescueSession,
  revokeSession,
  revokeAllForUser,
} from "./session.js";
import { signAccessToken, ACCESS_TTL_SECONDS } from "./token.js";
import { createAuthMiddleware, type AuthVariables } from "./middleware.js";
import { logEvent } from "./log.js";
import { createTracker, type StatEvent } from "./stats.js";
import { trimmedField } from "./body.js";
import { matchDemoAccount } from "./demo_account.js";
import { registerGithubOauth } from "./plugins/github.js";
import type { LoginConfig, VerifiedResult } from "./config.js";

export function createAuthApp<TEnv>(
  getConfig: (env: TEnv) => LoginConfig,
  basePath: string
) {
  const authMiddleware = createAuthMiddleware(getConfig);
  const auth = new Hono<{ Variables: AuthVariables }>().basePath(basePath);
  const cfg = (c: { env: unknown }) => getConfig(c.env as TEnv);
  const emit = (c: { env: unknown }) => cfg(c).onEvent ?? logEvent;
  // 统计事件统一出口：内部先喂 onEvent（形态与 1.3.0 一致），再异步落 auth_events
  const track = createTracker(getConfig);
  const accessTtl = (c: { env: unknown }) =>
    cfg(c).jwt.accessTtlSeconds ?? ACCESS_TTL_SECONDS;
  const sessionExpiry = (c: { env: unknown }) => {
    const ttl = cfg(c).session?.refreshTtlMs ?? null;
    // == null 而非 truthiness：0 是数值语义的「立即过期」，不是「不过期」
    return ttl == null ? null : Date.now() + ttl;
  };

  auth.post("/code/send", async (c) => {
    const body = await c.req
      .json<{ email?: string; locale?: unknown }>()
      .catch(() => ({} as { email?: string; locale?: unknown }));
    const raw = trimmedField(body.email).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(raw)) {
      return c.json({ error: "invalid_email" }, 400);
    }

    // 演示账号（见 demo_account.ts）：码为固定值且不真实发信，其余与常规一致。
    // 解析放在限流之前，撞限流的演示流量才带得上 demo 标
    const demo = matchDemoAccount(cfg(c), raw);

    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const rl = await checkSendRateLimit(cfg(c).kv, raw, ip);
    if (!rl.allowed) {
      // 命中限流不只是滥用信号，更是「用户发不出码」的体验问题——分层记录才知道
      // 是自己手快（cooldown）还是真被挡住（email / ip 窗口）
      track(c, {
        event: "rate_limited",
        outcome: rl.layer,
        meta: { endpoint: "code_send", ...(demo ? { demo: true } : {}) },
      });
      return c.json(
        { error: "too_many_requests", retryAfterSeconds: rl.retryAfterSeconds },
        429
      );
    }

    const code = demo?.code ?? generateCode();
    const emitEvent = emit(c);
    warnEmailConfigOnce(cfg(c).email, emitEvent);
    const locale = resolveEmailLocale(cfg(c).email, body.locale);
    if (demo === null) {
      try {
        await sendCodeEmail(cfg(c).email, raw, code, locale.locale);
      } catch (err) {
        // 发信失败此前不留任何痕迹；邮件是邮箱登录的命脉，断了整条链就没了。
        // Resend 的 HTTP 码在错误串里，聚合时再解析（不为此改造 email.ts 的抛错形态）。
        track(c, { event: "code_send_failed", meta: { message: String(err) } });
        return c.json({ error: "internal" }, 500);
      }
    }
    // 静默回落意味着「为什么收到英文邮件」在别处查不出来，故选中语言必须留痕
    track(c, {
      event: "code_sent",
      meta: {
        ...(demo ? { demo: true } : {}),
        locale: {
          resolved: locale.locale,
          ...(locale.requested ? { requested: locale.requested } : {}),
          ...(locale.fallback ? { fallback: true } : {}),
        },
      },
    });

    await storeCode(cfg(c).kv, raw, code);
    await recordSend(cfg(c).kv, raw, ip);
    return c.json({ cooldownSeconds: 60 }, 200);
  });

  auth.post("/code/verify", async (c) => {
    const body = await c.req
      .json<{ email?: string; code?: string }>()
      .catch(() => ({} as { email?: string; code?: string }));
    const email = trimmedField(body.email).toLowerCase();
    const code = trimmedField(body.code);

    // 演示账号在 verify 无任何行为分叉；仅给事件补 meta.demo，
    // 否则审核员的登录会混进真实登录漏斗（code_verify 不带 userId，事后剔不掉）
    const isDemo = matchDemoAccount(cfg(c), email) !== null;
    const t = (e: StatEvent) =>
      track(c, isDemo ? { ...e, meta: { ...e.meta, demo: true } } : e);

    const stored = await readCode(cfg(c).kv, email);
    if (!stored) {
      // 过期、已焚、从未发过、已用过——在 KV 层都表现为读不到，无法再分（C3 口径）
      t({ event: "code_verify", outcome: "code_not_found" });
      return c.json({ error: "code_expired" }, 400);
    }

    if (stored.code !== code) {
      const attempts = await incrementAttempts(cfg(c).kv, email, stored);
      if (attempts >= MAX_ATTEMPTS) {
        await deleteCode(cfg(c).kv, email);
        t({ event: "code_verify", outcome: "too_many_attempts" });
        return c.json({ error: "too_many_attempts" }, 429);
      }
      t({ event: "code_verify", outcome: "invalid_code" });
      return c.json({ error: "invalid_code" }, 400);
    }

    await deleteCode(cfg(c).kv, email);

    const userAgent = c.req.header("User-Agent") ?? undefined;
    const ip = c.req.header("CF-Connecting-IP") ?? undefined;

    // 用户语义（建号/试用/档案）全部在 App 侧钩子内完成；
    // 钩子失败 → 500（码已焚，重新发码），会话在钩子成功后才创建。
    let verified: VerifiedResult;
    try {
      verified = await cfg(c).onVerified({
        email,
        provider: "email",
        requestMeta: { ip, userAgent },
      });
    } catch {
      t({ event: "code_verify", outcome: "internal" });
      return c.json({ error: "internal" }, 500);
    }

    const { sessionId, refreshToken } = await createSession(cfg(c).db, {
      userId: verified.userId,
      userAgent,
      ip,
      expiresAt: sessionExpiry(c),
    });

    const accessToken = await signAccessToken(
      cfg(c).jwt.secret,
      verified.userId,
      sessionId,
      accessTtl(c)
    );

    t({ event: "code_verify", outcome: "ok" });
    // 「登录成功」的唯一口径落点：客户端拿到 token 对。GitHub 轨的同名事件在
    // /oauth/exchange 发（那里才是客户端真正拿到 token 的时刻）。
    t({
      event: "login",
      provider: "email",
      userId: verified.userId,
      ...(verified.isNewUser !== undefined ? { isNewUser: verified.isNewUser } : {}),
    });

    return c.json({
      accessToken,
      refreshToken,
      ...(verified.user !== undefined ? { user: verified.user } : {}),
      ...(verified.isNewUser !== undefined ? { isNewUser: verified.isNewUser } : {}),
    });
  });

  auth.post("/refresh", async (c) => {
    const body = await c.req
      .json<{ refreshToken?: string }>()
      .catch(() => ({} as { refreshToken?: string }));
    const token = trimmedField(body.refreshToken);
    if (!token) {
      track(c, { event: "refresh", outcome: "invalid", meta: { reason: "missing_token" } });
      return c.json(
        { error: "invalid_refresh_token", reason: "missing_token" },
        401
      );
    }

    const sessionId = await hashRefreshToken(token);
    const row = await findSession(cfg(c).db, sessionId);
    if (!row) {
      track(c, {
        event: "refresh",
        outcome: "invalid",
        meta: { reason: "session_not_found" },
      });
      return c.json(
        { error: "invalid_refresh_token", reason: "session_not_found" },
        401
      );
    }

    if (row.revoked_at !== null) {
      // 已轮换的 token 被再次提交：可能是"丢回执的诚实重试"，先尝试救活。
      const userAgent = c.req.header("User-Agent") ?? undefined;
      const ip = c.req.header("CF-Connecting-IP") ?? undefined;
      const rescue = await tryRescueSession(
        cfg(c).db,
        row,
        { userAgent, ip },
        sessionExpiry(c)
      );
      if (rescue.status === "rescued") {
        track(c, {
          event: "refresh",
          outcome: "rescued",
          userId: row.user_id,
          meta: { familyId: row.family_id },
          hookOnly: { ip: ip ?? null },
        });
        const accessToken = await signAccessToken(
          cfg(c).jwt.secret,
          row.user_id,
          rescue.session.sessionId,
          accessTtl(c)
        );
        return c.json({ accessToken, refreshToken: rescue.session.refreshToken });
      }
      // 救活不成立 → 判定真重用，撤销整条会话链。guardrail 与 not_eligible 分开记录。
      await revokeFamily(cfg(c).db, row.family_id);
      track(c, {
        event: "refresh",
        outcome:
          rescue.status === "guardrail" ? "guardrail_revoked" : "reuse_revoked",
        userId: row.user_id,
        meta: { familyId: row.family_id },
        hookOnly: { ip: ip ?? null },
      });
      return c.json(
        { error: "invalid_refresh_token", reason: "session_revoked" },
        401
      );
    }

    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      track(c, {
        event: "refresh",
        outcome: "invalid",
        userId: row.user_id,
        meta: { reason: "session_expired" },
      });
      return c.json(
        { error: "invalid_refresh_token", reason: "session_expired" },
        401
      );
    }

    const userAgent = c.req.header("User-Agent") ?? undefined;
    const ip = c.req.header("CF-Connecting-IP") ?? undefined;
    const next = await rotateSession(
      cfg(c).db,
      sessionId,
      { userAgent, ip },
      sessionExpiry(c)
    );
    if (!next) {
      track(c, {
        event: "refresh",
        outcome: "invalid",
        userId: row.user_id,
        meta: { reason: "rotate_failed" },
      });
      return c.json(
        { error: "invalid_refresh_token", reason: "rotate_failed" },
        401
      );
    }

    const accessToken = await signAccessToken(
      cfg(c).jwt.secret,
      row.user_id,
      next.sessionId,
      accessTtl(c)
    );

    // 成功续期此前不发事件，救活率（F2）因此一直没有分母
    track(c, {
      event: "refresh",
      outcome: "ok",
      userId: row.user_id,
      meta: { familyId: row.family_id },
    });

    return c.json({ accessToken, refreshToken: next.refreshToken });
  });

  auth.delete("/sessions", authMiddleware, async (c) => {
    const sessionId = c.get("sessionId");
    if (!sessionId) return c.json({ error: "unauthorized" }, 401);
    await revokeSession(cfg(c).db, sessionId);
    // 主动登出与「被轮换而作废」在 sessions 表里长得很像，只有事件能干净区分
    track(c, { event: "session_revoked", outcome: "current", userId: c.get("userId") });
    return c.body(null, 204);
  });

  auth.delete("/sessions/all", authMiddleware, async (c) => {
    const userId = c.get("userId");
    await revokeAllForUser(cfg(c).db, userId);
    track(c, { event: "session_revoked", outcome: "all", userId });
    return c.body(null, 204);
  });

  registerGithubOauth(auth, getConfig, basePath);

  return auth;
}
