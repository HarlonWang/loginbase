import type { EmailTemplate } from "../email.js";

// en 模板即 Tono 生产模板的 brand 参数化：brand="Tono" 时输出与平移前逐字节一致。
const title = (brand?: string) =>
  brand ? `Your ${brand} verification code` : "Your verification code";

export const enTemplate: Required<EmailTemplate> = {
  subject: (ctx) => `${title(ctx.brand)}: ${ctx.code}`,
  html: (ctx) => `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;">
      <h2 style="margin:0 0 16px 0;">${title(ctx.brand)}</h2>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0;">${ctx.code}</p>
      <p style="color:#666;font-size:14px;">This code expires in ${ctx.ttlMinutes} minutes. If you didn't request it, you can ignore this email.</p>
    </div>
  `,
  text: (ctx) =>
    `${title(ctx.brand)} is ${ctx.code}. It expires in ${ctx.ttlMinutes} minutes.`,
};
