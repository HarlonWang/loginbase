// 账号删除（3.1.0）：/account/delete/code + /account/delete
import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createLogin, storeCode, readCode } from "../src/index";
import type { AccountDeletionConfig, DeletionContext, LoginConfig } from "../src/index";
import { initDb, wipeKv, createTestUser, mailer, sentMessage } from "./helpers";

function makeLogin(overrides: Partial<LoginConfig> = {}) {
  return createLogin<Cloudflare.Env>((e) => ({
    db: e.DB,
    kv: e.EMAIL_CODES,
    jwt: { secret: e.JWT_SECRET },
    email: { send: mailer, from: e.EMAIL_FROM_ADDRESS, brand: "Tono" },
    onVerified: () => ({ userId: "u-fixed" }),
    ...overrides,
  }));
}

function deletion(over: Partial<AccountDeletionConfig> = {}): AccountDeletionConfig {
  return {
    emailOf: async (userId) => {
      const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
        .bind(userId)
        .first<{ email: string }>();
      return row?.email ?? null;
    },
    onDelete: async ({ userId }) => {
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    },
    ...over,
  };
}

type LoginApp = ReturnType<typeof makeLogin>["app"];

const post = (app: LoginApp, path: string, token: string, body: unknown = {}) =>
  app.request(
    `/auth${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "CF-Connecting-IP": "9.9.9.9",
      },
      body: JSON.stringify(body),
    },
    env
  );

const sessionCount = async (userId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>())!.n;

describe("账号删除", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
    await env.DB.prepare("DELETE FROM sessions").run();
    await env.DB.prepare("DELETE FROM users").run();
    mailer.mockClear();
  });

  it("未配置 accountDeletion → 两个端点都 404 not_configured", async () => {
    const { app } = makeLogin();
    const u = await createTestUser("a@x.com");
    for (const path of ["/account/delete/code", "/account/delete"]) {
      const res = await post(app, path, u.accessToken);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_configured" });
    }
  });

  it("无 token → 401", async () => {
    const { app } = makeLogin({ accountDeletion: deletion() });
    const res = await app.request("/auth/account/delete/code", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("发码：发往 emailOf 给的邮箱，用删号模板，码与登录码分存", async () => {
    const { app } = makeLogin({ accountDeletion: deletion() });
    const u = await createTestUser("a@x.com");
    const res = await post(app, "/account/delete/code", u.accessToken, { locale: "zh-CN" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cooldownSeconds: 60 });

    expect(mailer).toHaveBeenCalledTimes(1);
    const msg = sentMessage();
    expect(msg.to).toBe("a@x.com");
    expect(msg.subject).toMatch(/^确认删除 Tono 账号：\d{6}$/);
    expect(await readCode(env.EMAIL_CODES, "a@x.com", "delete_account")).not.toBeNull();
    expect(await readCode(env.EMAIL_CODES, "a@x.com")).toBeNull();
  });

  it("全流程：凭码删除 → onDelete 收到上下文、会话行全部物理删除、204", async () => {
    let seen: DeletionContext | undefined;
    const del = deletion();
    const { app } = makeLogin({
      accountDeletion: {
        ...del,
        onDelete: async (ctx) => {
          seen = ctx;
          await del.onDelete(ctx);
        },
      },
    });
    const u = await createTestUser("a@x.com");
    await createTestUser("a@x.com"); // 同用户第二个会话
    const other = await createTestUser("b@x.com");

    await post(app, "/account/delete/code", u.accessToken);
    const code = sentMessage().subject.slice(-6);
    const res = await post(app, "/account/delete", u.accessToken, { code });
    expect(res.status).toBe(204);

    expect(seen).toMatchObject({ userId: u.userId, email: "a@x.com" });
    expect(seen!.requestMeta.ip).toBe("9.9.9.9");
    expect(await sessionCount(u.userId)).toBe(0);
    expect(await sessionCount(other.userId)).toBe(1);
    expect(await readCode(env.EMAIL_CODES, "a@x.com", "delete_account")).toBeNull();
  });

  it("登录码不能用来删号", async () => {
    const { app } = makeLogin({ accountDeletion: deletion() });
    const u = await createTestUser("a@x.com");
    await storeCode(env.EMAIL_CODES, "a@x.com", "123456");
    const res = await post(app, "/account/delete", u.accessToken, { code: "123456" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "code_expired" });
    expect(await sessionCount(u.userId)).toBe(1);
  });

  it("错码计次，第 5 次焚码 429", async () => {
    const onDelete = vi.fn();
    const { app } = makeLogin({ accountDeletion: deletion({ onDelete }) });
    const u = await createTestUser("a@x.com");
    await storeCode(env.EMAIL_CODES, "a@x.com", "123456", "delete_account");
    for (let i = 1; i < 5; i++) {
      const res = await post(app, "/account/delete", u.accessToken, { code: "000000" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_code" });
    }
    const last = await post(app, "/account/delete", u.accessToken, { code: "000000" });
    expect(last.status).toBe(429);
    expect(await last.json()).toEqual({ error: "too_many_attempts" });
    expect(await readCode(env.EMAIL_CODES, "a@x.com", "delete_account")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("check 拒绝 → 发码与删除都 409，reason 透传，不发信", async () => {
    const onDelete = vi.fn();
    const { app } = makeLogin({
      accountDeletion: deletion({
        check: () => ({ ok: false, reason: "active_subscription" }),
        onDelete,
      }),
    });
    const u = await createTestUser("a@x.com");
    const r1 = await post(app, "/account/delete/code", u.accessToken);
    expect(r1.status).toBe(409);
    expect(await r1.json()).toEqual({ error: "deletion_blocked", reason: "active_subscription" });
    expect(mailer).not.toHaveBeenCalled();

    await storeCode(env.EMAIL_CODES, "a@x.com", "123456", "delete_account");
    const r2 = await post(app, "/account/delete", u.accessToken, { code: "123456" });
    expect(r2.status).toBe(409);
    expect(onDelete).not.toHaveBeenCalled();
    // 被拒时码不焚：用户去取消订阅后回来还能用
    expect(await readCode(env.EMAIL_CODES, "a@x.com", "delete_account")).not.toBeNull();
  });

  it("check 给出非法 reason → 回落 blocked", async () => {
    const { app } = makeLogin({
      accountDeletion: deletion({ check: () => ({ ok: false, reason: "has space" }) }),
    });
    const u = await createTestUser("a@x.com");
    const res = await post(app, "/account/delete/code", u.accessToken);
    expect(await res.json()).toEqual({ error: "deletion_blocked", reason: "blocked" });
  });

  it("emailOf 返回 null → 404 account_not_found", async () => {
    const { app } = makeLogin({ accountDeletion: deletion({ emailOf: () => null }) });
    const u = await createTestUser("a@x.com");
    const res = await post(app, "/account/delete/code", u.accessToken);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "account_not_found" });
  });

  it("onDelete 抛错 → 500，会话保留", async () => {
    const { app } = makeLogin({
      accountDeletion: deletion({
        onDelete: () => {
          throw new Error("paddle down");
        },
      }),
    });
    const u = await createTestUser("a@x.com");
    await storeCode(env.EMAIL_CODES, "a@x.com", "123456", "delete_account");
    const res = await post(app, "/account/delete", u.accessToken, { code: "123456" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(await sessionCount(u.userId)).toBe(1);
  });

  it("发码与登录发码共用限流", async () => {
    const { app } = makeLogin({ accountDeletion: deletion() });
    const u = await createTestUser("a@x.com");
    expect((await post(app, "/account/delete/code", u.accessToken)).status).toBe(200);
    const res = await post(app, "/account/delete/code", u.accessToken);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "too_many_requests" });
  });

  it("演示账号：固定码、不发信", async () => {
    const { app } = makeLogin({
      accountDeletion: deletion(),
      demoAccount: { email: "review@x.com", code: "424242" },
    });
    const u = await createTestUser("review@x.com");
    expect((await post(app, "/account/delete/code", u.accessToken)).status).toBe(200);
    expect(mailer).not.toHaveBeenCalled();
    const res = await post(app, "/account/delete", u.accessToken, { code: "424242" });
    expect(res.status).toBe(204);
  });
});
