import { describe, it, expect, beforeEach } from "vitest";
import { app, env, initDb, createTestUser } from "./helpers";

describe("DELETE /auth/sessions(/all)", () => {
  beforeEach(async () => {
    await initDb();
    await env.DB.prepare("DELETE FROM sessions").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("DELETE /auth/sessions → 当前 session 被 revoke", async () => {
    const a = await createTestUser("a@x.com");
    const res = await app.request(
      "/auth/sessions",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.accessToken}` },
      },
      env
    );
    expect(res.status).toBe(204);
    const row = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(a.sessionId)
      .first<{ revoked_at: number | null }>();
    expect(row!.revoked_at).not.toBeNull();
  });

  it("DELETE /auth/sessions/all → 该用户所有 session 被 revoke，其他用户不受影响", async () => {
    const a1 = await createTestUser("a@x.com");
    const a2 = await createTestUser("a@x.com");
    const b = await createTestUser("b@x.com");

    const res = await app.request(
      "/auth/sessions/all",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a1.accessToken}` },
      },
      env
    );
    expect(res.status).toBe(204);

    for (const id of [a1.sessionId, a2.sessionId]) {
      const row = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
        .bind(id)
        .first<{ revoked_at: number | null }>();
      expect(row!.revoked_at).not.toBeNull();
    }
    const bRow = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(b.sessionId)
      .first<{ revoked_at: number | null }>();
    expect(bRow!.revoked_at).toBeNull();
  });

  it("无 token → 401", async () => {
    const res = await app.request("/auth/sessions", { method: "DELETE" }, env);
    expect(res.status).toBe(401);
  });
});
