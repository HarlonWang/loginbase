import { describe, it, expect, beforeEach } from "vitest";
import { app, env, initDb, createTestUser, authHeader } from "./helpers";

async function me(token: string) {
  return app.request(
    "/auth/me",
    { method: "GET", headers: await authHeader(token) },
    env
  );
}

describe("GET /auth/me", () => {
  beforeEach(async () => {
    await initDb();
    await env.DB.prepare("DELETE FROM sessions").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("认证用户 → 200 返回当前 user（id/email/isPro/proExpiresAt/createdAt）", async () => {
    const { accessToken, user, userId } = await createTestUser("me@example.com");
    const res = await me(accessToken);
    expect(res.status).toBe(200);
    const body = await res.json<{
      id: string;
      email: string;
      isPro: boolean;
      proExpiresAt: number | null;
      createdAt: number;
    }>();
    expect(body.id).toBe(userId);
    expect(body.email).toBe("me@example.com");
    expect(body.isPro).toBe(true);
    expect(body.proExpiresAt).toBe(user.proExpiresAt);
  });

  it("服务端改 pro_expires_at 后 /auth/me 反映最新（无需重新登录即感知续费/赠送）", async () => {
    const { accessToken, userId } = await createTestUser("grant@example.com", {
      isPro: false,
    });
    // 初始：已过期 → free
    const r1 = await me(accessToken);
    expect((await r1.json<{ isPro: boolean }>()).isPro).toBe(false);

    // 服务端延长 pro（如手动赠送 / 收据续费）
    const future = Date.now() + 90 * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE users SET pro_expires_at = ? WHERE id = ?")
      .bind(future, userId)
      .run();

    // 同一 access token 再查 → 已是 Pro
    const r2 = await me(accessToken);
    const body = await r2.json<{ isPro: boolean; proExpiresAt: number }>();
    expect(body.isPro).toBe(true);
    expect(body.proExpiresAt).toBe(future);
  });

  it("无 token → 401", async () => {
    const res = await app.request(
      "/auth/me",
      { method: "GET", headers: { "Content-Type": "application/json" } },
      env
    );
    expect(res.status).toBe(401);
  });
});
