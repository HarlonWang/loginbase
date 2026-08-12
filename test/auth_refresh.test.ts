import { describe, it, expect, beforeEach, vi } from "vitest";
import { app, env, initDb } from "./helpers";
import { createSession, hashRefreshToken, findSession } from "../src/session";

// 从 console.log 的 spy 里抽出 refresh 结构化事件的 outcome 序列
function refreshOutcomes(spy: ReturnType<typeof vi.spyOn>): string[] {
  return (spy.mock.calls as unknown[][])
    .map((c): { event?: string; outcome?: string } | null => {
      try {
        return JSON.parse(c[0] as string);
      } catch {
        return null;
      }
    })
    .filter((e): e is { event: string; outcome: string } => !!e && e.event === "refresh")
    .map((e) => e.outcome);
}

async function refresh(refreshToken: string) {
  return app.request(
    "/auth/refresh",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    },
    env
  );
}

describe("POST /auth/refresh", () => {
  beforeEach(async () => {
    await initDb();
    await env.DB.prepare("DELETE FROM sessions").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("合法 refresh → 200 + 新 access + 新 refresh，旧行被 revoke 并指向新行", async () => {
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, email, pro_expires_at, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(userId, "u@x.com", Date.now() + 30 * 86400000, Date.now())
      .run();
    const old = await createSession(env.DB, { userId });

    const res = await refresh(old.refreshToken);
    expect(res.status).toBe(200);
    const data = await res.json<{ accessToken: string; refreshToken: string }>();
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
    expect(data.refreshToken).not.toBe(old.refreshToken);

    const newId = await hashRefreshToken(data.refreshToken);
    const oldRow = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(old.sessionId)
      .first<{ revoked_at: number | null; replaced_by_id: string | null; family_id: string }>();
    const newRow = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(newId)
      .first<{ revoked_at: number | null; family_id: string }>();
    expect(oldRow!.revoked_at).not.toBeNull();
    expect(oldRow!.replaced_by_id).toBe(newId);
    expect(newRow!.revoked_at).toBeNull();
    expect(newRow!.family_id).toBe(oldRow!.family_id);
  });

  it("不存在的 refresh → 401 invalid_refresh_token + reason=session_not_found", async () => {
    const res = await refresh("nope-not-a-real-token");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "invalid_refresh_token",
      reason: "session_not_found",
    });
  });

  async function newUser() {
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, email, pro_expires_at, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(userId, `${userId}@x.com`, Date.now() + 30 * 86400000, Date.now())
      .run();
    return userId;
  }

  async function tokenFrom(res: Response) {
    return (await res.json<{ refreshToken: string }>()).refreshToken;
  }

  it("丢回执诚实重试：旧 token 已轮换但直接后继仍 active → 救活发新证、不杀 family", async () => {
    const old = await createSession(env.DB, { userId: await newUser() });

    // 服务端轮换成功生成 t1，但客户端没收到回执（仍持 old）
    const t1 = await tokenFrom(await refresh(old.refreshToken));

    // 客户端拿 old 再试一次：后继 t1 仍 active → 应救活而非杀 family
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const r2 = await refresh(old.refreshToken);
    expect(r2.status).toBe(200);
    expect(refreshOutcomes(logSpy)).toContain("rescued");
    logSpy.mockRestore();
    const t2 = await tokenFrom(r2);
    expect(t2).not.toBe(t1);

    // t2 行 active 且与 old 同 family（链未被撤销）
    const t2Row = await findSession(env.DB, await hashRefreshToken(t2));
    expect(t2Row!.revoked_at).toBeNull();
    expect(t2Row!.family_id).toBe(old.familyId);

    // 救活时被轮换掉的后继 t1 已 revoke
    const t1Row = await findSession(env.DB, await hashRefreshToken(t1));
    expect(t1Row!.revoked_at).not.toBeNull();

    // 客户端拿到的 t2 能继续正常 refresh
    expect((await refresh(t2)).status).toBe(200);
  });

  it("真重用：旧 token 的后继已被再轮换（链已前进）→ 401 session_revoked + 整 family 撤销", async () => {
    const old = await createSession(env.DB, { userId: await newUser() });

    const t1 = await tokenFrom(await refresh(old.refreshToken));
    const t2 = await tokenFrom(await refresh(t1)); // 链前进：t1 被正常轮换掉

    // old 的直接后继 t1 已 revoke → 再用 old = 真重用
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await refresh(old.refreshToken);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({
      error: "invalid_refresh_token",
      reason: "session_revoked",
    });
    expect(refreshOutcomes(logSpy)).toContain("reuse_revoked");
    logSpy.mockRestore();

    // 整 family 撤销：当前 active tip t2 也被 revoke
    const t2Row = await findSession(env.DB, await hashRefreshToken(t2));
    expect(t2Row!.revoked_at).not.toBeNull();
  });

  it("救活护栏：同一 family 短时间连续救活超过上限 → 401 + 撤销", async () => {
    const old = await createSession(env.DB, { userId: await newUser() });

    const tok: string[] = [old.refreshToken];
    tok.push(await tokenFrom(await refresh(tok[0]))); // t1：正常轮换（非救活）

    // 连续用"上一个被轮换的旧 token"重试，后继都 active → 连续救活
    for (let i = 0; i < 3; i++) {
      const r = await refresh(tok[i]);
      expect(r.status).toBe(200);
      tok.push(await tokenFrom(r));
    }

    // 第 4 次救活超过护栏上限 → 拒绝并撤销
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const blocked = await refresh(tok[3]);
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toMatchObject({
      error: "invalid_refresh_token",
      reason: "session_revoked",
    });
    expect(refreshOutcomes(logSpy)).toContain("guardrail_revoked");
    logSpy.mockRestore();
  });

  it("空 body / 缺 refreshToken → 401 reason=missing_token", async () => {
    const r = await app.request(
      "/auth/refresh",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env
    );
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({
      error: "invalid_refresh_token",
      reason: "missing_token",
    });
  });
});
