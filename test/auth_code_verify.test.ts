import { describe, it, expect, beforeEach } from "vitest";
import { app, env, initDb } from "./helpers";
import { storeCode } from "../src/code";
import { hashRefreshToken } from "../src/session";
import { verifyAccessToken } from "../src/token";

async function wipeKv() {
  const list = await env.EMAIL_CODES.list();
  for (const key of list.keys) await env.EMAIL_CODES.delete(key.name);
}

async function verify(email: string, code: string) {
  return app.request(
    "/auth/code/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "test-ua" },
      body: JSON.stringify({ email, code }),
    },
    env
  );
}

describe("POST /auth/code/verify", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
  });

  it("新邮箱核验成功 → 创建 user + session，返回 isNewUser=true、双 token", async () => {
    await storeCode(env.EMAIL_CODES, "new@example.com", "111111");
    const res = await verify("new@example.com", "111111");
    expect(res.status).toBe(200);
    const data = await res.json<{
      accessToken: string;
      refreshToken: string;
      user: any;
      isNewUser: boolean;
    }>();
    expect(data.isNewUser).toBe(true);
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
    expect(data.user.email).toBe("new@example.com");
    expect(data.user.isPro).toBe(true);

    const payload = await verifyAccessToken(env.JWT_SECRET, data.accessToken);
    expect(payload.sub).toBe(data.user.id);
    expect(payload.sid).toBeTruthy();

    const sid = await hashRefreshToken(data.refreshToken);
    expect(payload.sid).toBe(sid);
    const sess = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(sid)
      .first<{ user_id: string; family_id: string; expires_at: number | null; revoked_at: number | null }>();
    expect(sess).not.toBeNull();
    expect(sess!.user_id).toBe(data.user.id);
    expect(sess!.family_id).toBeTruthy();
    expect(sess!.expires_at).toBeNull();
    expect(sess!.revoked_at).toBeNull();

    expect(await env.EMAIL_CODES.get("code:new@example.com")).toBeNull();
  });

  it("新用户默认 Pro 试用为 3 个月（约 90 天）", async () => {
    await storeCode(env.EMAIL_CODES, "trial@example.com", "111111");
    const before = Date.now();
    const res = await verify("trial@example.com", "111111");
    const after = Date.now();
    const data = await res.json<{ user: { proExpiresAt: number } }>();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(data.user.proExpiresAt).toBeGreaterThanOrEqual(before + ninetyDays);
    expect(data.user.proExpiresAt).toBeLessThanOrEqual(after + ninetyDays);
  });

  it("已存在用户核验成功 → isNewUser=false，不覆盖 pro_expires_at", async () => {
    const id = crypto.randomUUID();
    const oldExpiry = Date.now() + 1000 * 60 * 60 * 24 * 365;
    await env.DB.prepare(
      "INSERT INTO users (id, email, pro_expires_at, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(id, "old@example.com", oldExpiry, Date.now())
      .run();

    await storeCode(env.EMAIL_CODES, "old@example.com", "222222");
    const res = await verify("old@example.com", "222222");
    expect(res.status).toBe(200);
    const data = await res.json<{ user: any; isNewUser: boolean; refreshToken: string }>();
    expect(data.isNewUser).toBe(false);
    expect(data.user.proExpiresAt).toBe(oldExpiry);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM sessions WHERE user_id = ?"
    )
      .bind(id)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("验证码不匹配 → 400 invalid_code，attempts 递增，code 仍在", async () => {
    await storeCode(env.EMAIL_CODES, "u@example.com", "123456");
    const res = await verify("u@example.com", "000000");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_code" });
    const kv = await env.EMAIL_CODES.get("code:u@example.com");
    expect(kv).not.toBeNull();
    expect(JSON.parse(kv!).attempts).toBe(1);
  });

  it("无验证码记录 → 400 code_expired", async () => {
    const res = await verify("u@example.com", "111111");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "code_expired" });
  });

  it("连错 5 次 → 第 5 次返回 429 too_many_attempts，code 被删", async () => {
    await storeCode(env.EMAIL_CODES, "u@example.com", "123456");
    for (let i = 0; i < 4; i++) {
      const r = await verify("u@example.com", "000000");
      expect(r.status).toBe(400);
    }
    const r5 = await verify("u@example.com", "000000");
    expect(r5.status).toBe(429);
    expect(await r5.json()).toEqual({ error: "too_many_attempts" });
    expect(await env.EMAIL_CODES.get("code:u@example.com")).toBeNull();
  });
});
