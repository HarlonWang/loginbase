import { CODE_TTL_SECONDS } from "./code.js";
import { enTemplate } from "./templates/en.js";
import { zhTemplate } from "./templates/zh.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** 模板渲染上下文（2.0.0：由裸 code 参数改为 ctx 对象） */
export interface TemplateContext {
  code: string;
  brand?: string;
  /** 本封邮件的「选中语言」——已归一化的 BCP 47 标签 */
  locale: string;
  /** 收件地址（已归一化小写） */
  email: string;
  /** 验证码有效期，解开「10 分钟」写死在文案里的约定耦合 */
  ttlMinutes: number;
}

export type TemplatePart = (ctx: TemplateContext) => string;

/** 三件皆可选：内置已有的语言可以只覆盖其中一件，其余由内置同语言补齐 */
export interface EmailTemplate {
  subject?: TemplatePart;
  html?: TemplatePart;
  text?: TemplatePart;
}

export interface EmailConfig {
  resendApiKey: string;
  from: string;
  /** 品牌名，经 ctx.brand 送达内置模板与消费方模板 */
  brand?: string;
  /**
   * 客户端没说时用哪个语言（2.0.0：原 `locale`，语义由「本 App 邮件语言」正名为
   * 「兜底语言」）。默认 "en"；配了库不支持的语言则回落 "en" 并告警。
   */
  fallbackLocale?: string;
  /** 按 locale 键：覆盖内置语言的任意部件，或新增内置没有的语言（须三件齐全） */
  templates?: Record<string, EmailTemplate>;
}

const BUILTIN: Record<string, Required<EmailTemplate>> = {
  en: enTemplate,
  zh: zhTemplate,
};
const BUILTIN_FALLBACK_LOCALE = "en";
const MAX_LOCALE_LENGTH = 64;
const PARTS = ["subject", "html", "text"] as const;

/**
 * BCP 47 标签归一化：`_`→`-`（Android `Locale.toString()` 给的是 `zh_CN`，
 * 只有 `toLanguageTag()` 才是 BCP 47）、转小写（大小写不敏感）、截断 64。
 *
 * 非字符串、空串、含 `[a-z0-9-]` 以外字符者一律返回 null＝「视为未传」：
 * 这类值本就匹配不到任何语言，行为与未传等价，顺便把垃圾挡在事件日志之外。
 *
 * `und`（BCP 47 的「未确定语言」）同样归为未传——客户端取不到平台语言时可能传它，
 * 若当成普通标签处理，它会匹配失败并留下 `fallback: true`，把「取不到语言」伪装成
 * 「要了一门不支持的语言」，污染观测（见 plan.md 的哨兵口径）。
 */
export function normalizeLocale(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().slice(0, MAX_LOCALE_LENGTH).replace(/_/g, "-").toLowerCase();
  if (tag === "" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(tag)) return null;
  if (tag === "und" || tag.startsWith("und-")) return null;
  return tag;
}

// 消费方模板的键同样要归一化（他可能写 "zh-Hant"），按 templates 对象记忆化
const indexCache = new WeakMap<object, Map<string, EmailTemplate>>();
function customIndex(config: EmailConfig): Map<string, EmailTemplate> {
  const src = config.templates;
  if (!src) return new Map();
  const cached = indexCache.get(src);
  if (cached) return cached;
  const index = new Map<string, EmailTemplate>();
  for (const [key, template] of Object.entries(src)) {
    const tag = normalizeLocale(key);
    if (tag && template) index.set(tag, template);
  }
  indexCache.set(src, index);
  return index;
}

function isComplete(template: EmailTemplate | undefined): boolean {
  return !!template && PARTS.every((p) => typeof template[p] === "function");
}

/**
 * 支持集 = 库内置语言 ∪ { 消费方写全三件的语言 }。
 *
 * 判据不是「消费方写了几件」，而是「缺的几件能不能用**同一种语言**补上」：
 * 内置已有的语言永远补得上，故部分覆盖合法；内置没有的语言只有消费方一个来源，
 * 不写全就没人能补——此时判定该语言不成立，整封回落兜底语言（见 server-design.md
 * 「为什么禁止跨语言混搭」）。
 */
function supports(config: EmailConfig, locale: string): boolean {
  return locale in BUILTIN || isComplete(customIndex(config).get(locale));
}

/**
 * RFC 4647 Lookup 简化版：逐级砍子标签（`zh-hans-cn`→`zh-hans`→`zh`），
 * 不一步截到主语言——将来加繁体模板时 `zh-Hant` 才不会掉进简体。
 */
function lookup(tag: string, has: (locale: string) => boolean): string | null {
  let current = tag;
  for (;;) {
    if (has(current)) return current;
    const cut = current.lastIndexOf("-");
    if (cut < 0) return null;
    current = current.slice(0, cut);
  }
}

export interface LocaleResolution {
  /** 选中语言 */
  locale: string;
  /** 客户端传来并通过归一化的值（未传/非法时缺省） */
  requested?: string;
  /** true = 客户端要的语言没给到（未传不算回落） */
  fallback: boolean;
}

/**
 * 规则 ①：语言只解析一次——请求 → fallbackLocale → 库内置 en，第一个命中者胜。
 * **静默回落，永不 4xx**：语言是展示偏好不是凭据，一个 4xx 会让用户登不进去。
 */
export function resolveEmailLocale(
  config: EmailConfig,
  requested: unknown
): LocaleResolution {
  const has = (locale: string) => supports(config, locale);
  const req = normalizeLocale(requested);
  if (req) {
    const hit = lookup(req, has);
    if (hit) return { locale: hit, requested: req, fallback: false };
  }
  const configured = normalizeLocale(config.fallbackLocale);
  const locale =
    (configured ? lookup(configured, has) : null) ?? BUILTIN_FALLBACK_LOCALE;
  return req
    ? { locale, requested: req, fallback: true }
    : { locale, fallback: false };
}

/**
 * 规则 ②：模板在选中语言内部合并——内置打底，消费方逐部件覆盖，永不跨语言。
 * （末尾的内置兜底只为防御式直调；走 resolveEmailLocale 的路径上取不到它。）
 */
export function resolveTemplate(
  config: EmailConfig,
  locale: string
): Required<EmailTemplate> {
  const custom = customIndex(config).get(locale);
  const builtin = BUILTIN[locale];
  const pick = (part: (typeof PARTS)[number]): TemplatePart =>
    custom?.[part] ?? builtin?.[part] ?? BUILTIN[BUILTIN_FALLBACK_LOCALE][part];
  return { subject: pick("subject"), html: pick("html"), text: pick("text") };
}

/**
 * 配置层面的问题清单（纯函数，便于测试）：
 * - `incomplete`：给了内置没有的语言却没写全三件——他的模板一次都不会被用上，
 *   而配置语法完全合法、从代码里看不出来，不报就只能靠用户投诉发现；
 * - `unsupported_fallback`：兜底语言自己都不在支持集里，实际会用库内置 en。
 */
export function emailConfigWarnings(
  config: EmailConfig
): Record<string, unknown>[] {
  const warnings: Record<string, unknown>[] = [];
  // 归一化认不出的键（如 "中文"、"zh Hant"）会被索引直接丢掉——语法合法、
  // 却永远不会被任何请求命中，是彻底的死配置，不报就只能靠用户投诉发现
  for (const key of Object.keys(config.templates ?? {})) {
    if (normalizeLocale(key) === null) {
      warnings.push({
        event: "email_template_config",
        status: "invalid_locale_key",
        key,
      });
    }
  }
  for (const [locale, template] of customIndex(config)) {
    if (locale in BUILTIN) continue; // 内置能同语言补齐，部分覆盖合法
    const missing = PARTS.filter((p) => typeof template[p] !== "function");
    if (missing.length > 0) {
      warnings.push({
        event: "email_template_config",
        status: "incomplete",
        locale,
        missing,
      });
    }
  }
  const configured = normalizeLocale(config.fallbackLocale);
  if (configured && !lookup(configured, (l) => supports(config, l))) {
    warnings.push({
      event: "email_template_config",
      status: "unsupported_fallback",
      locale: configured,
      resolved: BUILTIN_FALLBACK_LOCALE,
    });
  }
  return warnings;
}

// 每个 config 对象只报一次（config 按 isolate 记忆化 → 等价于每实例一次）。
// 不抛错、不阻断：模板配错不该让登录服务起不来，与「静默回落」同一取向。
const warned = new WeakSet<object>();
export function warnEmailConfigOnce(
  config: EmailConfig,
  emit: (event: Record<string, unknown>) => void
): void {
  if (warned.has(config)) return;
  warned.add(config);
  for (const warning of emailConfigWarnings(config)) emit(warning);
}

export async function sendCodeEmail(
  config: EmailConfig,
  email: string,
  code: string,
  locale: string = BUILTIN_FALLBACK_LOCALE
): Promise<void> {
  const template = resolveTemplate(config, locale);
  const ctx: TemplateContext = {
    code,
    brand: config.brand,
    locale,
    email,
    ttlMinutes: Math.round(CODE_TTL_SECONDS / 60),
  };
  const body = {
    from: config.from,
    to: [email],
    subject: template.subject(ctx),
    html: template.html(ctx),
    text: template.text(ctx),
  };

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.resendApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Resend failed: ${res.status} ${msg}`);
  }
}
