import type { EmailTemplate, TemplateContext } from "../email.js";

// en 模板即 Tono 生产模板的 brand 参数化：brand="Tono" 时登录邮件与平移前逐字节一致。
// 删号邮件（3.1.0 起）换标题，并把「忽略即可」换成「有人拿到了你的登录态」的警示。
const title = ({ brand, purpose }: TemplateContext) =>
  purpose === "delete_account"
    ? brand
      ? `Confirm deleting your ${brand} account`
      : "Confirm deleting your account"
    : brand
      ? `Your ${brand} verification code`
      : "Your verification code";

const notice = (ctx: TemplateContext) =>
  ctx.purpose === "delete_account"
    ? `Entering this code permanently deletes your account. It expires in ${ctx.ttlMinutes} minutes. If you didn't request this, don't share the code with anyone and sign out of your other devices.`
    : `This code expires in ${ctx.ttlMinutes} minutes. If you didn't request it, you can ignore this email.`;

export const enTemplate: Required<EmailTemplate> = {
  subject: (ctx) => `${title(ctx)}: ${ctx.code}`,
  html: (ctx) => `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;">
      <h2 style="margin:0 0 16px 0;">${title(ctx)}</h2>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0;">${ctx.code}</p>
      <p style="color:#666;font-size:14px;">${notice(ctx)}</p>
    </div>
  `,
  text: (ctx) =>
    ctx.purpose === "delete_account"
      ? `${title(ctx)}: ${ctx.code}. ${notice(ctx)}`
      : `${title(ctx)} is ${ctx.code}. It expires in ${ctx.ttlMinutes} minutes.`,
};
