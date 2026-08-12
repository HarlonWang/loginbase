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
import { sendCodeEmail } from "./email.js";
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
  const accessTtl = (c: { env: unknown }) =>
    cfg(c).jwt.accessTtlSeconds ?? ACCESS_TTL_SECONDS;
  const sessionExpiry = (c: { env: unknown }) => {
    const ttl = cfg(c).session?.refreshTtlMs ?? null;
    // == null 而非 truthiness：0 是数值语义的「立即过期」，不是「不过期」
    return ttl == null ? null : Date.now() + ttl;
  };

  auth.post("/code/send", async (c) => {
    const body = await c.req
      .json<{ email?: string }>()
      .catch(() => ({} as { email?: string }));
    const raw = (body.email ?? "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(raw)) {
      return c.json({ error: "invalid_email" }, 400);
    }

    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const rl = await checkSendRateLimit(cfg(c).kv, raw, ip);
    if (!rl.allowed) {
      return c.json(
        { error: "too_many_requests", retryAfterSeconds: rl.retryAfterSeconds },
        429
      );
    }

    const code = generateCode();
    try {
      await sendCodeEmail(cfg(c).email, raw, code);
    } catch {
      return c.json({ error: "internal" }, 500);
    }

    await storeCode(cfg(c).kv, raw, code);
    await recordSend(cfg(c).kv, raw, ip);
    return c.json({ cooldownSeconds: 60 }, 200);
  });

  auth.post("/code/verify", async (c) => {
    const body = await c.req
      .json<{ email?: string; code?: string }>()
      .catch(() => ({} as { email?: string; code?: string }));
    const email = (body.email ?? "").trim().toLowerCase();
    const code = (body.code ?? "").trim();

    const stored = await readCode(cfg(c).kv, email);
    if (!stored) return c.json({ error: "code_expired" }, 400);

    if (stored.code !== code) {
      const attempts = await incrementAttempts(cfg(c).kv, email, stored);
      if (attempts >= MAX_ATTEMPTS) {
        await deleteCode(cfg(c).kv, email);
        return c.json({ error: "too_many_attempts" }, 429);
      }
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
    const token = (body.refreshToken ?? "").trim();
    if (!token) {
      return c.json(
        { error: "invalid_refresh_token", reason: "missing_token" },
        401
      );
    }

    const sessionId = await hashRefreshToken(token);
    const row = await findSession(cfg(c).db, sessionId);
    if (!row) {
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
        emit(c)({
          event: "refresh",
          outcome: "rescued",
          userId: row.user_id,
          familyId: row.family_id,
          ip: ip ?? null,
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
      emit(c)({
        event: "refresh",
        outcome:
          rescue.status === "guardrail" ? "guardrail_revoked" : "reuse_revoked",
        userId: row.user_id,
        familyId: row.family_id,
        ip: ip ?? null,
      });
      return c.json(
        { error: "invalid_refresh_token", reason: "session_revoked" },
        401
      );
    }

    if (row.expires_at !== null && row.expires_at <= Date.now()) {
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

    return c.json({ accessToken, refreshToken: next.refreshToken });
  });

  auth.delete("/sessions", authMiddleware, async (c) => {
    const sessionId = c.get("sessionId");
    if (!sessionId) return c.json({ error: "unauthorized" }, 401);
    await revokeSession(cfg(c).db, sessionId);
    return c.body(null, 204);
  });

  auth.delete("/sessions/all", authMiddleware, async (c) => {
    const userId = c.get("userId");
    await revokeAllForUser(cfg(c).db, userId);
    return c.body(null, 204);
  });

  registerGithubOauth(auth, getConfig, basePath);

  return auth;
}
