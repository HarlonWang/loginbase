import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { app, env, initDb } from "./helpers";

async function wipeKv() {
  const list = await env.EMAIL_CODES.list();
  for (const key of list.keys) await env.EMAIL_CODES.delete(key.name);
}

describe("POST /auth/code/send", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await initDb();
    await wipeKv();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  async function send(email: string, ip = "1.1.1.1", locale?: unknown) {
    return app.request(
      "/auth/code/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify(locale === undefined ? { email } : { email, locale }),
      },
      env
    );
  }

  const sentSubject = () => {
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string).subject as string;
  };

  it("合法邮箱 → 200 { cooldownSeconds }，KV 写入 code:* 与 cooldown:*", async () => {
    const res = await send("u@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cooldownSeconds: 60 });
    expect(await env.EMAIL_CODES.get("code:u@example.com")).not.toBeNull();
    expect(await env.EMAIL_CODES.get("cooldown:u@example.com")).toBe("1");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("大小写 / 首尾空格 被规范化", async () => {
    await send("  U@Example.com  ");
    expect(await env.EMAIL_CODES.get("code:u@example.com")).not.toBeNull();
  });

  it("非法邮箱 → 400 invalid_email，不落 KV、不发邮件", async () => {
    const res = await send("not-an-email");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
    expect(fetchSpy).not.toHaveBeenCalled();
    const list = await env.EMAIL_CODES.list();
    expect(list.keys).toHaveLength(0);
  });

  it("60 秒内连发 → 第 2 次 429 too_many_requests", async () => {
    await send("u@example.com");
    const res = await send("u@example.com");
    expect(res.status).toBe(429);
    const body = await res.json<{ error: string; retryAfterSeconds: number }>();
    expect(body.error).toBe("too_many_requests");
    expect(body.retryAfterSeconds).toBe(60);
  });

  it("Resend 返回 5xx → 500 internal，不落 KV", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    const res = await send("u@example.com");
    expect(res.status).toBe(500);
    expect(await env.EMAIL_CODES.get("code:u@example.com")).toBeNull();
    expect(await env.EMAIL_CODES.get("cooldown:u@example.com")).toBeNull();
  });

  it("账号是否存在都返回相同响应（防枚举）", async () => {
    const res = await send("never-registered@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cooldownSeconds: 60 });
  });

  // 夹具的 email 配置未设 fallbackLocale → 兜底 en（protocol 1.3.0 新增请求级 locale）
  describe("请求级 locale", () => {
    it("传 zh-Hans-CN → 中文邮件", async () => {
      await send("a@example.com", "1.1.1.1", "zh-Hans-CN");
      expect(sentSubject()).toContain("Tono 登录验证码");
    });

    it("传 Android 风格的 zh_CN 同样命中中文", async () => {
      await send("b@example.com", "1.1.1.2", "zh_CN");
      expect(sentSubject()).toContain("Tono 登录验证码");
    });

    it("不传 → 兜底英文", async () => {
      await send("c@example.com", "1.1.1.3");
      expect(sentSubject()).toMatch(/^Your Tono verification code: \d{6}$/);
    });

    it("传不支持的语言 → 静默回落英文，仍 200（永不 4xx）", async () => {
      const res = await send("d@example.com", "1.1.1.4", "fr");
      expect(res.status).toBe(200);
      expect(sentSubject()).toContain("Your Tono verification code");
    });

    it("传非字符串 → 视为未传，不炸", async () => {
      const res = await send("e@example.com", "1.1.1.5", { evil: true });
      expect(res.status).toBe(200);
      expect(sentSubject()).toContain("Your Tono verification code");
    });
  });
});
