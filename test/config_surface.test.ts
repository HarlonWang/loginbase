// 配置面测试（第 2 步新增）：refreshTtlMs 滑动过期、accessTtlSeconds 可配
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  createLogin,
  createSession,
  hashRefreshToken,
  storeCode,
  verifyAccessToken,
} from "../src/index";
import { initDb, wipeKv } from "./helpers";

const HOUR_MS = 60 * 60 * 1000;

const ttlLogin = createLogin<Cloudflare.Env>((e) => ({
  db: e.DB,
  kv: e.EMAIL_CODES,
  jwt: { secret: e.JWT_SECRET, accessTtlSeconds: 60 },
  email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
  session: { refreshTtlMs: HOUR_MS },
  onVerified: () => ({ userId: "u-ttl" }),
}));

async function refresh(token: string) {
  return ttlLogin.app.request(
    "/auth/refresh",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: token }),
    },
    env
  );
}

describe("session.refreshTtlMs", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
    await env.DB.prepare("DELETE FROM sessions").run();
  });

  it("verify 创建的会话带 expires_at ≈ now + ttl", async () => {
    await storeCode(env.EMAIL_CODES, "ttl@x.com", "111111");
    const before = Date.now();
    const res = await ttlLogin.app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ttl@x.com", code: "111111" }),
      },
      env
    );
    expect(res.status).toBe(200);
    const { refreshToken } = await res.json<{ refreshToken: string }>();
    const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE id = ?")
      .bind(await hashRefreshToken(refreshToken))
      .first<{ expires_at: number | null }>();
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + HOUR_MS);
    expect(row!.expires_at).toBeLessThanOrEqual(Date.now() + HOUR_MS);
  });

  it("轮换滑动续期：新行 expires_at 重新起算", async () => {
    const old = await createSession(env.DB, {
      userId: "u-ttl",
      expiresAt: Date.now() + 1000, // 快过期的旧会话
    });
    const before = Date.now();
    const res = await refresh(old.refreshToken);
    expect(res.status).toBe(200);
    const { refreshToken } = await res.json<{ refreshToken: string }>();
    const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE id = ?")
      .bind(await hashRefreshToken(refreshToken))
      .first<{ expires_at: number | null }>();
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + HOUR_MS);
  });

  it("已过期会话 refresh → 401 session_expired", async () => {
    const old = await createSession(env.DB, {
      userId: "u-ttl",
      expiresAt: Date.now() - 1000,
    });
    const res = await refresh(old.refreshToken);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "invalid_refresh_token",
      reason: "session_expired",
    });
  });
});

describe("jwt.accessTtlSeconds", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
  });

  it("verify 签发的 access token exp-iat = 配置值", async () => {
    await storeCode(env.EMAIL_CODES, "att@x.com", "222222");
    const res = await ttlLogin.app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "att@x.com", code: "222222" }),
      },
      env
    );
    const { accessToken } = await res.json<{ accessToken: string }>();
    const payload = await verifyAccessToken(env.JWT_SECRET, accessToken);
    expect(payload.exp! - payload.iat!).toBe(60);
  });
});
