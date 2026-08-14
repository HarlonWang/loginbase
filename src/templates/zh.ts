import type { EmailTemplate } from "../email.js";

const title = (brand?: string) => (brand ? `${brand} 登录验证码` : "登录验证码");

export const zhTemplate: Required<EmailTemplate> = {
  subject: (ctx) => `${title(ctx.brand)}：${ctx.code}`,
  html: (ctx) => `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;padding:24px;">
      <h2 style="margin:0 0 16px 0;">${title(ctx.brand)}</h2>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0;">${ctx.code}</p>
      <p style="color:#666;font-size:14px;">验证码 ${ctx.ttlMinutes} 分钟内有效。如果这不是你的操作，请忽略这封邮件。</p>
    </div>
  `,
  text: (ctx) => `你的${title(ctx.brand)}是 ${ctx.code}，${ctx.ttlMinutes} 分钟内有效。`,
};
