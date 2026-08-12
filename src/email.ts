import { enTemplates } from "./templates/en.js";
import { zhTemplates } from "./templates/zh.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailTemplates {
  subject(code: string): string;
  html(code: string): string;
  text(code: string): string;
}

export interface EmailConfig {
  resendApiKey: string;
  from: string;
  /** 品牌名，注入内置模板的标题与正文；不影响 templates 整体覆盖 */
  brand?: string;
  /** 内置模板语言，默认 "en" */
  locale?: "en" | "zh";
  /** 整体覆盖模板；提供时 brand/locale 不生效 */
  templates?: EmailTemplates;
}

export function resolveTemplates(config: EmailConfig): EmailTemplates {
  if (config.templates) return config.templates;
  return config.locale === "zh" ? zhTemplates(config.brand) : enTemplates(config.brand);
}

export async function sendCodeEmail(
  config: EmailConfig,
  email: string,
  code: string
): Promise<void> {
  const templates = resolveTemplates(config);
  const body = {
    from: config.from,
    to: [email],
    subject: templates.subject(code),
    html: templates.html(code),
    text: templates.text(code),
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
