import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { sendCodeEmail, type EmailConfig, type EmailMessage } from "../src/email";

// 平移时的机械改动：sendCodeEmail 第一参数由 Env 改为 EmailConfig（config 注入）
const emailConfig: EmailConfig = {
  resendApiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM_ADDRESS,
  brand: "Tono",
};

describe("sendCodeEmail", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "re_123" }), { status: 200 })
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it("调 Resend API 并传入正确 from / to / subject / html", async () => {
    await sendCodeEmail(emailConfig, "u@x.com", "123456");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe(env.EMAIL_FROM_ADDRESS);
    expect(body.to).toEqual(["u@x.com"]);
    expect(body.subject).toContain("Tono");
    expect(body.html).toContain("123456");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${env.RESEND_API_KEY}`
    );
  });

  it("Resend 返回非 2xx → 抛错", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(sendCodeEmail(emailConfig, "u@x.com", "123456")).rejects.toThrow();
  });

  it("配了 send → 交给它投递，不调 Resend", async () => {
    const sent: EmailMessage[] = [];
    const config: EmailConfig = {
      send: async (m) => { sent.push(m); },
      from: env.EMAIL_FROM_ADDRESS,
      brand: "Tono",
    };
    await sendCodeEmail(config, "u@x.com", "123456");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(env.EMAIL_FROM_ADDRESS);
    expect(sent[0].to).toBe("u@x.com");
    expect(sent[0].subject).toContain("Tono");
    expect(sent[0].html).toContain("123456");
    expect(sent[0].text).toContain("123456");
  });

  it("send 抛错 → sendCodeEmail 抛错", async () => {
    const config: EmailConfig = {
      send: async () => { throw new Error("ses down"); },
      from: env.EMAIL_FROM_ADDRESS,
    };
    await expect(sendCodeEmail(config, "u@x.com", "123456")).rejects.toThrow("ses down");
  });
});
