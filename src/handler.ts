// 从 Tono-Server src/auth/handler.ts 原样平移（落地第 1 步，铁律 3）。
// 仅两类机械改动：c.env.X 读取改为 config 注入、import 路径调整。
// 内联的用户 upsert / 90 天试用 / /me 端点为 Tono 业务语义，暂留库内，
// 第 2 步钩子化（onVerified）时移回 Tono。
import { Hono } from "hono";
import {
  generateCode,
  storeCode,
  readCode,
  deleteCode,
  incrementAttempts,
  MAX_ATTEMPTS,
} from "./code";
import { sendCodeEmail } from "./email";
import { checkSendRateLimit, recordSend } from "./rate_limit";
import {
  createSession,
  hashRefreshToken,
  findSession,
  rotateSession,
  revokeFamily,
  tryRescueSession,
  revokeSession,
  revokeAllForUser,
} from "./session";
import { signAccessToken } from "./token";
import { createAuthMiddleware, type AuthVariables } from "./middleware";
import { logEvent } from "./log";
import type { LoginConfig } from "./config";

// 新用户注册赠送的 Pro 试用时长（3 个月）
const TRIAL_PERIOD_MS = 90 * 24 * 60 * 60 * 1000;

export function createAuthApp<TEnv>(
  getConfig: (env: TEnv) => LoginConfig,
  basePath: string
) {
  const authMiddleware = createAuthMiddleware(getConfig);
  const auth = new Hono<{ Variables: AuthVariables }>().basePath(basePath);
  const cfg = (c: { env: unknown }) => getConfig(c.env as TEnv);

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

    const now = Date.now();
    let user = await cfg(c)
      .db.prepare(
        "SELECT id, email, pro_expires_at, created_at FROM users WHERE email = ?"
      )
      .bind(email)
      .first<{
        id: string;
        email: string;
        pro_expires_at: number | null;
        created_at: number;
      }>();

    let isNewUser = false;
    if (!user) {
      const id = crypto.randomUUID();
      const proExpiresAt = now + TRIAL_PERIOD_MS;
      await cfg(c)
        .db.prepare(
          "INSERT INTO users (id, email, pro_expires_at, created_at) VALUES (?, ?, ?, ?)"
        )
        .bind(id, email, proExpiresAt, now)
        .run();
      user = { id, email, pro_expires_at: proExpiresAt, created_at: now };
      isNewUser = true;
    }

    const userAgent = c.req.header("User-Agent") ?? null;
    const ip = c.req.header("CF-Connecting-IP") ?? null;
    const { sessionId, refreshToken } = await createSession(cfg(c).db, {
      userId: user.id,
      userAgent: userAgent ?? undefined,
      ip: ip ?? undefined,
    });

    const accessToken = await signAccessToken(
      cfg(c).jwt.secret,
      user.id,
      sessionId
    );

    return c.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        isPro: user.pro_expires_at != null && user.pro_expires_at > now,
        proExpiresAt: user.pro_expires_at,
        createdAt: user.created_at,
      },
      isNewUser,
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
      const rescue = await tryRescueSession(cfg(c).db, row, { userAgent, ip });
      if (rescue.status === "rescued") {
        logEvent({
          event: "refresh",
          outcome: "rescued",
          userId: row.user_id,
          familyId: row.family_id,
          ip: ip ?? null,
        });
        const accessToken = await signAccessToken(
          cfg(c).jwt.secret,
          row.user_id,
          rescue.session.sessionId
        );
        return c.json({ accessToken, refreshToken: rescue.session.refreshToken });
      }
      // 救活不成立 → 判定真重用，撤销整条会话链。guardrail 与 not_eligible 分开记录。
      await revokeFamily(cfg(c).db, row.family_id);
      logEvent({
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
    const next = await rotateSession(cfg(c).db, sessionId, { userAgent, ip });
    if (!next) {
      return c.json(
        { error: "invalid_refresh_token", reason: "rotate_failed" },
        401
      );
    }

    const accessToken = await signAccessToken(
      cfg(c).jwt.secret,
      row.user_id,
      next.sessionId
    );

    return c.json({ accessToken, refreshToken: next.refreshToken });
  });

  // 返回当前登录用户的最新信息（含实时 Pro 状态），供客户端在前台/启动时刷新本地缓存，
  // 无需重新登录即可感知服务端 pro_expires_at 的变化（续费 / 到期 / 手动赠送）。
  auth.get("/me", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const row = await cfg(c)
      .db.prepare(
        "SELECT id, email, pro_expires_at, created_at FROM users WHERE id = ?"
      )
      .bind(userId)
      .first<{
        id: string;
        email: string;
        pro_expires_at: number | null;
        created_at: number;
      }>();
    if (!row) return c.json({ error: "user_not_found" }, 404);
    const now = Date.now();
    return c.json({
      id: row.id,
      email: row.email,
      isPro: row.pro_expires_at != null && row.pro_expires_at > now,
      proExpiresAt: row.pro_expires_at,
      createdAt: row.created_at,
    });
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

  return auth;
}
