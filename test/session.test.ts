import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  generateRefreshToken,
  hashRefreshToken,
  createSession,
  findSession,
  rotateSession,
  revokeFamily,
  revokeSession,
  revokeAllForUser,
  tryRescueSession,
} from "../src/session";
import { initDb } from "./helpers";

async function wipe() {
  await env.DB.prepare("DELETE FROM sessions").run();
}

describe("session", () => {
  beforeEach(async () => {
    await initDb();
    await wipe();
  });

  it("generateRefreshToken 返回 base64url 32 字节", () => {
    const t = generateRefreshToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(43);
  });

  it("hashRefreshToken 稳定且不可逆（同输入同输出，hex 64 位）", async () => {
    const a = await hashRefreshToken("abc");
    const b = await hashRefreshToken("abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("createSession 写一行，findSession 按 hash 查到", async () => {
    const { sessionId, refreshToken, familyId } = await createSession(env.DB, {
      userId: "u-1",
      userAgent: "test",
      ip: "1.1.1.1",
    });
    const row = await findSession(env.DB, sessionId);
    expect(row).not.toBeNull();
    expect(row!.user_id).toBe("u-1");
    expect(row!.family_id).toBe(familyId);
    expect(row!.expires_at).toBeNull();
    expect(row!.revoked_at).toBeNull();
    expect(refreshToken).toBeTruthy();
  });

  it("rotateSession：旧 revoked + replaced_by_id，新行 family 相同", async () => {
    const old = await createSession(env.DB, { userId: "u-1" });
    const next = await rotateSession(env.DB, old.sessionId, { ip: "2.2.2.2" });
    const oldRow = await findSession(env.DB, old.sessionId);
    const newRow = await findSession(env.DB, next!.sessionId);
    expect(oldRow!.revoked_at).not.toBeNull();
    expect(oldRow!.replaced_by_id).toBe(next!.sessionId);
    expect(newRow!.family_id).toBe(old.familyId);
    expect(newRow!.revoked_at).toBeNull();
  });

  it("tryRescueSession：被轮换的旧 session 其后继仍 active → status rescued + 从后继轮换发新证、同 family", async () => {
    const old = await createSession(env.DB, { userId: "u-1" });
    const next = await rotateSession(env.DB, old.sessionId, {}); // old 被轮换，next 为 active tip
    const oldRow = await findSession(env.DB, old.sessionId); // revoked，replaced_by → next

    const r = await tryRescueSession(env.DB, oldRow!, { ip: "9.9.9.9" });
    expect(r.status).toBe("rescued");
    if (r.status !== "rescued") throw new Error("unreachable");
    const rescuedRow = await findSession(env.DB, r.session.sessionId);
    expect(rescuedRow!.revoked_at).toBeNull();
    expect(rescuedRow!.family_id).toBe(old.familyId);
    expect(rescuedRow!.rescued_at).not.toBeNull();
    // 原后继被轮换掉
    expect((await findSession(env.DB, next!.sessionId))!.revoked_at).not.toBeNull();
  });

  it("tryRescueSession：后继已 revoked（链已前进）→ status not_eligible", async () => {
    const old = await createSession(env.DB, { userId: "u-1" });
    const t1 = await rotateSession(env.DB, old.sessionId, {});
    await rotateSession(env.DB, t1!.sessionId, {}); // 链前进，t1 也被 revoke
    const oldRow = await findSession(env.DB, old.sessionId);

    const r = await tryRescueSession(env.DB, oldRow!, {});
    expect(r.status).toBe("not_eligible");
  });

  it("revokeFamily 撤销同 family 全部活跃 session", async () => {
    const a = await createSession(env.DB, { userId: "u-1" });
    const b = await rotateSession(env.DB, a.sessionId, {});
    const c = await rotateSession(env.DB, b!.sessionId, {});
    await revokeFamily(env.DB, a.familyId);
    for (const id of [a.sessionId, b!.sessionId, c!.sessionId]) {
      const row = await findSession(env.DB, id);
      expect(row!.revoked_at).not.toBeNull();
    }
  });

  it("revokeAllForUser 只影响该用户", async () => {
    const a = await createSession(env.DB, { userId: "u-1" });
    const b = await createSession(env.DB, { userId: "u-2" });
    await revokeAllForUser(env.DB, "u-1");
    expect((await findSession(env.DB, a.sessionId))!.revoked_at).not.toBeNull();
    expect((await findSession(env.DB, b.sessionId))!.revoked_at).toBeNull();
  });

  it("revokeSession 只影响指定行", async () => {
    const a = await createSession(env.DB, { userId: "u-1" });
    const b = await createSession(env.DB, { userId: "u-1" });
    await revokeSession(env.DB, a.sessionId);
    expect((await findSession(env.DB, a.sessionId))!.revoked_at).not.toBeNull();
    expect((await findSession(env.DB, b.sessionId))!.revoked_at).toBeNull();
  });
});
