// 邮件模板体系测试（第 2 步新增）：内置 zh/en、brand 注入、templates 整体覆盖
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { sendCodeEmail, resolveTemplates } from "../src/email";
import { enTemplates } from "../src/templates/en";
import { zhTemplates } from "../src/templates/zh";

describe("内置模板", () => {
  it("en + brand=Tono 与 Tono 平移前的生产模板逐字节一致", () => {
    const t = enTemplates("Tono");
    expect(t.subject("123456")).toBe("Your Tono verification code: 123456");
    expect(t.text("123456")).toBe(
      "Your Tono verification code is 123456. It expires in 10 minutes."
    );
    expect(t.html("123456")).toContain(
      '<h2 style="margin:0 0 16px 0;">Your Tono verification code</h2>'
    );
    expect(t.html("123456")).toContain("123456");
  });

  it("en 无 brand 时优雅降级", () => {
    const t = enTemplates();
    expect(t.subject("111111")).toBe("Your verification code: 111111");
  });

  it("zh 模板含品牌与验证码", () => {
    const t = zhTemplates("Tono");
    expect(t.subject("654321")).toBe("Tono 登录验证码：654321");
    expect(t.text("654321")).toContain("654321");
    expect(t.html("654321")).toContain("654321");
    expect(t.html("654321")).toContain("10 分钟内有效");
  });

  it("resolveTemplates：locale=zh 选中文；缺省选英文；templates 覆盖一切", () => {
    const base = { resendApiKey: "k", from: "f" };
    expect(resolveTemplates({ ...base, locale: "zh" }).subject("1")).toContain("验证码");
    expect(resolveTemplates({ ...base }).subject("1")).toContain("verification code");
    const custom = {
      subject: (c: string) => `custom-${c}`,
      html: (c: string) => `<b>${c}</b>`,
      text: (c: string) => c,
    };
    expect(
      resolveTemplates({ ...base, locale: "zh", brand: "X", templates: custom }).subject("9")
    ).toBe("custom-9");
  });
});

describe("sendCodeEmail 走模板体系", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it("custom templates 覆盖生效", async () => {
    await sendCodeEmail(
      {
        resendApiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM_ADDRESS,
        templates: {
          subject: (c) => `[MyApp] code ${c}`,
          html: (c) => `<i>${c}</i>`,
          text: (c) => `code=${c}`,
        },
      },
      "u@x.com",
      "888888"
    );
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.subject).toBe("[MyApp] code 888888");
    expect(body.html).toBe("<i>888888</i>");
    expect(body.text).toBe("code=888888");
  });

  it("locale=zh 内置模板发中文邮件", async () => {
    await sendCodeEmail(
      {
        resendApiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM_ADDRESS,
        brand: "测试品牌",
        locale: "zh",
      },
      "u@x.com",
      "777777"
    );
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.subject).toBe("测试品牌 登录验证码：777777");
  });
});
