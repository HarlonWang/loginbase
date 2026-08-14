// onVerified / onEvent 钩子契约测试（第 2 步新增）
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { createLogin, storeCode } from "../src/index";
import type { LoginConfig, VerifiedIdentity } from "../src/index";
import { initDb, wipeKv, createTestUser } from "./helpers";

function makeLogin(overrides: Partial<LoginConfig> = {}) {
  return createLogin<Cloudflare.Env>((e) => ({
    db: e.DB,
    kv: e.EMAIL_CODES,
    jwt: { secret: e.JWT_SECRET },
    email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
    onVerified: () => ({ userId: "u-fixed" }),
    ...overrides,
  }));
}

type LoginApp = ReturnType<typeof makeLogin>["app"];

async function verify(app: LoginApp, email: string, code: string) {
  return app.request(
    "/auth/code/verify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "hook-ua",
        "CF-Connecting-IP": "7.7.7.7",
      },
      body: JSON.stringify({ email, code }),
    },
    env
  );
}

describe("onVerified", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
    await env.DB.prepare("DELETE FROM sessions").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("入参：email 已归一化、provider=email、requestMeta 带 ip/ua", async () => {
    let seen: VerifiedIdentity | undefined;
    const login = makeLogin({
      onVerified: (identity: VerifiedIdentity) => {
        seen = identity;
        return { userId: "u-1" };
      },
    });
    await storeCode(env.EMAIL_CODES, "hook@example.com", "111111");
    const res = await verify(login.app, "  Hook@Example.com ", "111111");
    expect(res.status).toBe(200);
    expect(seen).toEqual({
      email: "hook@example.com",
      provider: "email",
      requestMeta: { ip: "7.7.7.7", userAgent: "hook-ua" },
    });
    // email provider 恒不携带 providerProfile（契约行为，防未来误填充）
    expect(seen && "providerProfile" in seen).toBe(false);
  });

  it("返回值透传：user / isNewUser 原样进响应；只返回 userId 时二者缺席", async () => {
    const rich = makeLogin({
      onVerified: () => ({
        userId: "u-1",
        isNewUser: true,
        user: { plan: "pro", nested: { a: 1 } },
      }),
    });
    await storeCode(env.EMAIL_CODES, "a@x.com", "111111");
    const r1 = await verify(rich.app, "a@x.com", "111111");
    const b1 = await r1.json<Record<string, unknown>>();
    expect(b1.isNewUser).toBe(true);
    expect(b1.user).toEqual({ plan: "pro", nested: { a: 1 } });

    const bare = makeLogin({ onVerified: () => ({ userId: "u-2" }) });
    await storeCode(env.EMAIL_CODES, "b@x.com", "222222");
    const r2 = await verify(bare.app, "b@x.com", "222222");
    const b2 = await r2.json<Record<string, unknown>>();
    expect(b2.accessToken).toBeTruthy();
    expect("user" in b2).toBe(false);
    expect("isNewUser" in b2).toBe(false);
  });

  it("钩子抛错 → 500 internal，码已焚、不留孤儿 session", async () => {
    const login = makeLogin({
      onVerified: () => {
        throw new Error("app-side failure");
      },
    });
    await storeCode(env.EMAIL_CODES, "boom@x.com", "333333");
    const res = await verify(login.app, "boom@x.com", "333333");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(await env.EMAIL_CODES.get("code:boom@x.com")).toBeNull();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions")
      .first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("onEvent", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await initDb();
    await env.DB.prepare("DELETE FROM sessions").run();
    await env.DB.prepare("DELETE FROM users").run();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it("配置 onEvent 后事件走钩子、不再走默认 console.log", async () => {
    const events: Record<string, unknown>[] = [];
    const login = makeLogin({ onEvent: (e: Record<string, unknown>) => events.push(e) });

    const { refreshToken } = await createTestUser("evt@x.com");
    const refresh = (token: string) =>
      login.app.request(
        "/auth/refresh",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: token }),
        },
        env
      );

    await refresh(refreshToken); // 正常轮换
    const r2 = await refresh(refreshToken); // 丢回执重试 → rescued
    expect(r2.status).toBe(200);

    expect(events.map((e) => e.outcome)).toContain("rescued");
    expect(logSpy).not.toHaveBeenCalled();
  });

  // 静默回落是有意设计（永不 4xx），代价是不可观测——故语言解析结果必须留痕
  describe("邮件语言留痕（1.3.0）", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(async () => {
      await wipeKv();
      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
    });
    afterEach(() => fetchSpy.mockRestore());

    async function sendWith(
      email: Partial<LoginConfig["email"]>,
      body: Record<string, unknown>
    ) {
      const events: Record<string, unknown>[] = [];
      const login = makeLogin({
        email: {
          resendApiKey: env.RESEND_API_KEY,
          from: env.EMAIL_FROM_ADDRESS,
          ...email,
        },
        onEvent: (e: Record<string, unknown>) => events.push(e),
      });
      const res = await login.app.request(
        "/auth/code/send",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
          body: JSON.stringify(body),
        },
        env
      );
      return { res, events };
    }

    it("命中时记选中语言，未传不算回落", async () => {
      const { events } = await sendWith({}, { email: "l1@x.com", locale: "zh-Hans-CN" });
      expect(events).toContainEqual({
        event: "code_sent",
        locale: { resolved: "zh", requested: "zh-hans-cn" },
      });

      const plain = await sendWith({}, { email: "l2@x.com" });
      expect(plain.events).toContainEqual({
        event: "code_sent",
        locale: { resolved: "en" },
      });
    });

    it("回落时标记 fallback，可据此统计不传 locale 的老客户端占比", async () => {
      const { events } = await sendWith({}, { email: "l3@x.com", locale: "fr" });
      expect(events).toContainEqual({
        event: "code_sent",
        locale: { resolved: "en", requested: "fr", fallback: true },
      });
    });

    it("配置有问题时首次发信即告警（不阻断发送）", async () => {
      const { res, events } = await sendWith(
        { templates: { ja: { subject: (c) => c.code } } },
        { email: "l4@x.com", locale: "ja" }
      );
      expect(res.status).toBe(200);
      expect(events).toContainEqual({
        event: "email_template_config",
        status: "incomplete",
        locale: "ja",
        missing: ["html", "text"],
      });
    });
  });
});
