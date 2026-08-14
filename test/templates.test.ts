// 邮件语言与模板体系（2.0.0 重写；原第 2 步的「内置 zh/en + 整体覆盖」测试并入）。
// 规则见 docs/server-design.md「语言与模板体系」：①语言只解析一次 ②同语言内合并
// ③选中语言不在支持集则整封回落兜底语言。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  sendCodeEmail,
  normalizeLocale,
  resolveEmailLocale,
  resolveTemplate,
  emailConfigWarnings,
  warnEmailConfigOnce,
  type EmailConfig,
  type TemplateContext,
} from "../src/email";
import { enTemplate } from "../src/templates/en";
import { zhTemplate } from "../src/templates/zh";

const base: EmailConfig = { resendApiKey: "k", from: "f" };
const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  code: "123456",
  locale: "en",
  email: "u@x.com",
  ttlMinutes: 10,
  ...over,
});

describe("内置模板", () => {
  it("en + brand=Tono 与 Tono 平移前的生产模板逐字节一致", () => {
    const c = ctx({ brand: "Tono" });
    expect(enTemplate.subject(c)).toBe("Your Tono verification code: 123456");
    expect(enTemplate.text(c)).toBe(
      "Your Tono verification code is 123456. It expires in 10 minutes."
    );
    expect(enTemplate.html(c)).toContain(
      '<h2 style="margin:0 0 16px 0;">Your Tono verification code</h2>'
    );
    expect(enTemplate.html(c)).toContain("123456");
  });

  it("en 无 brand 时优雅降级", () => {
    expect(enTemplate.subject(ctx({ code: "111111" }))).toBe(
      "Your verification code: 111111"
    );
  });

  it("zh 模板含品牌与验证码", () => {
    const c = ctx({ brand: "Tono", code: "654321", locale: "zh" });
    expect(zhTemplate.subject(c)).toBe("Tono 登录验证码：654321");
    expect(zhTemplate.text(c)).toContain("654321");
    expect(zhTemplate.html(c)).toContain("654321");
    expect(zhTemplate.html(c)).toContain("10 分钟内有效");
  });

  // 以下两个组合从未上过生产（TrendingAI 一直 zh、Tono 一直 en），
  // 快照在此定桩：zh+Tono 将随第 5 步 Tono-Android 接入首次发出。
  it("zh + brand=Tono 快照", () => {
    const c = ctx({ brand: "Tono", locale: "zh" });
    expect(zhTemplate.subject(c)).toBe("Tono 登录验证码：123456");
    expect(zhTemplate.text(c)).toBe("你的Tono 登录验证码是 123456，10 分钟内有效。");
  });

  it("en + brand=TrendingAI 快照", () => {
    const c = ctx({ brand: "TrendingAI" });
    expect(enTemplate.subject(c)).toBe(
      "Your TrendingAI verification code: 123456"
    );
    expect(enTemplate.text(c)).toBe(
      "Your TrendingAI verification code is 123456. It expires in 10 minutes."
    );
  });

  it("有效期文案由 ctx.ttlMinutes 决定，不再写死", () => {
    expect(enTemplate.text(ctx({ ttlMinutes: 5 }))).toContain("expires in 5 minutes");
    expect(zhTemplate.html(ctx({ ttlMinutes: 5 }))).toContain("5 分钟内有效");
  });
});

describe("normalizeLocale", () => {
  it("下划线转连字符、转小写（Android toString() 给的是 zh_CN）", () => {
    expect(normalizeLocale("zh_CN")).toBe("zh-cn");
    expect(normalizeLocale("en-GB")).toBe("en-gb");
    expect(normalizeLocale("  zh-Hans-CN  ")).toBe("zh-hans-cn");
  });

  it("非字符串/空串/非法字符一律视为未传", () => {
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale(123)).toBeNull();
    expect(normalizeLocale({})).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale("   ")).toBeNull();
    expect(normalizeLocale("zh<script>")).toBeNull();
    expect(normalizeLocale("zh-")).toBeNull();
  });

  it("und（未确定语言）视为未传，不留假的 fallback 痕迹", () => {
    expect(normalizeLocale("und")).toBeNull();
    expect(normalizeLocale("und-US")).toBeNull();
    expect(resolveEmailLocale(base, "und")).toEqual({ locale: "en", fallback: false });
  });

  it("超长标签截断到 64", () => {
    expect(normalizeLocale("a".repeat(100))).toHaveLength(64);
  });
});

describe("规则①：语言解析", () => {
  it("逐级砍子标签：zh-hans-cn → zh", () => {
    const r = resolveEmailLocale(base, "zh-Hans-CN");
    expect(r).toEqual({ locale: "zh", requested: "zh-hans-cn", fallback: false });
  });

  it("未知语言静默回落兜底语言，并标记 fallback", () => {
    expect(resolveEmailLocale(base, "fr")).toEqual({
      locale: "en",
      requested: "fr",
      fallback: true,
    });
    expect(resolveEmailLocale({ ...base, fallbackLocale: "zh" }, "fr")).toEqual({
      locale: "zh",
      requested: "fr",
      fallback: true,
    });
  });

  it("未传不算回落：走兜底语言但 fallback=false", () => {
    expect(resolveEmailLocale(base, undefined)).toEqual({
      locale: "en",
      fallback: false,
    });
    expect(resolveEmailLocale({ ...base, fallbackLocale: "zh" }, null)).toEqual({
      locale: "zh",
      fallback: false,
    });
  });

  it("兜底语言自己不在支持集时回落库内置 en", () => {
    expect(resolveEmailLocale({ ...base, fallbackLocale: "ja" }, undefined).locale).toBe(
      "en"
    );
  });

  it("消费方新增语言写全三件即进支持集", () => {
    const config: EmailConfig = {
      ...base,
      templates: {
        ja: {
          subject: (c) => `件名 ${c.code}`,
          html: (c) => `<b>${c.code}</b>`,
          text: (c) => `${c.code}`,
        },
      },
    };
    expect(resolveEmailLocale(config, "ja").locale).toBe("ja");
  });

  it("新增语言只写一件 → 该语言不成立，整封回落兜底语言", () => {
    const config: EmailConfig = {
      ...base,
      templates: { ja: { subject: (c) => `件名 ${c.code}` } },
    };
    expect(resolveEmailLocale(config, "ja")).toEqual({
      locale: "en",
      requested: "ja",
      fallback: true,
    });
  });

  it("消费方补上 zh-hant 后，zh-Hant 不再掉进简体", () => {
    const zhHant: EmailConfig = {
      ...base,
      templates: {
        "zh-Hant": {
          subject: (c) => `驗證碼 ${c.code}`,
          html: (c) => `<b>${c.code}</b>`,
          text: (c) => `${c.code}`,
        },
      },
    };
    expect(resolveEmailLocale(base, "zh-Hant").locale).toBe("zh"); // 今天
    expect(resolveEmailLocale(zhHant, "zh-Hant").locale).toBe("zh-hant"); // 补上之后
    // 三级标签才能区分「逐级砍」与「一步截到主语言」：后者会让台湾用户掉进简体
    expect(resolveEmailLocale(zhHant, "zh-Hant-TW").locale).toBe("zh-hant");
  });
});

describe("规则②：同语言内合并，永不跨语言", () => {
  it("内置语言允许部分覆盖，缺件由同语言内置补齐", () => {
    const config: EmailConfig = {
      ...base,
      brand: "TrendingAI",
      templates: { zh: { subject: (c) => `${c.brand} 验证码：${c.code}` } },
    };
    const t = resolveTemplate(config, "zh");
    const c = ctx({ brand: "TrendingAI", locale: "zh" });
    expect(t.subject(c)).toBe("TrendingAI 验证码：123456");
    expect(t.html(c)).toContain("分钟内有效"); // 来自内置 zh，仍是中文
    expect(t.text(c)).toContain("分钟内有效");
  });

  it("三件齐全时完全接管，brand 仍经 ctx 送达（不再被覆盖杀掉）", () => {
    const config: EmailConfig = {
      ...base,
      brand: "MyApp",
      templates: {
        en: {
          subject: (c) => `[${c.brand}] ${c.code}`,
          html: (c) => `<i>${c.locale}</i>`,
          text: (c) => `${c.email}`,
        },
      },
    };
    const t = resolveTemplate(config, "en");
    const c = ctx({ brand: "MyApp" });
    expect(t.subject(c)).toBe("[MyApp] 123456");
    expect(t.html(c)).toBe("<i>en</i>");
    expect(t.text(c)).toBe("u@x.com");
  });
});

describe("配置告警", () => {
  it("新增语言缺件时报 incomplete 并列出缺哪几件", () => {
    const config: EmailConfig = {
      ...base,
      templates: { ja: { subject: (c) => c.code } },
    };
    expect(emailConfigWarnings(config)).toEqual([
      {
        event: "email_template_config",
        status: "incomplete",
        locale: "ja",
        missing: ["html", "text"],
      },
    ]);
  });

  it("内置语言的部分覆盖不告警（同语言补得上）", () => {
    const config: EmailConfig = {
      ...base,
      templates: { zh: { subject: (c) => c.code } },
    };
    expect(emailConfigWarnings(config)).toEqual([]);
  });

  it("兜底语言不受支持时报 unsupported_fallback", () => {
    expect(emailConfigWarnings({ ...base, fallbackLocale: "ja" })).toEqual([
      {
        event: "email_template_config",
        status: "unsupported_fallback",
        locale: "ja",
        resolved: "en",
      },
    ]);
  });

  it("每个 config 只报一次", () => {
    const config: EmailConfig = { ...base, fallbackLocale: "ja" };
    const emit = vi.fn();
    warnEmailConfigOnce(config, emit);
    warnEmailConfigOnce(config, emit);
    warnEmailConfigOnce(config, emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe("sendCodeEmail 走模板体系", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
  });
  afterEach(() => fetchSpy.mockRestore());

  const sentBody = () => {
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string);
  };

  it("消费方模板覆盖生效", async () => {
    await sendCodeEmail(
      {
        resendApiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM_ADDRESS,
        templates: {
          en: {
            subject: (c) => `[MyApp] code ${c.code}`,
            html: (c) => `<i>${c.code}</i>`,
            text: (c) => `code=${c.code}`,
          },
        },
      },
      "u@x.com",
      "888888"
    );
    expect(sentBody()).toMatchObject({
      subject: "[MyApp] code 888888",
      html: "<i>888888</i>",
      text: "code=888888",
    });
  });

  it("选中语言 zh 时发中文邮件", async () => {
    await sendCodeEmail(
      {
        resendApiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM_ADDRESS,
        brand: "测试品牌",
      },
      "u@x.com",
      "777777",
      "zh"
    );
    expect(sentBody().subject).toBe("测试品牌 登录验证码：777777");
  });

  it("缺省选中语言为 en", async () => {
    await sendCodeEmail(
      { resendApiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM_ADDRESS },
      "u@x.com",
      "999999"
    );
    expect(sentBody().subject).toBe("Your verification code: 999999");
  });
});
