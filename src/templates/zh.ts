import type { EmailTemplate, TemplateContext } from "../email.js";

const title = ({ brand, purpose }: TemplateContext) =>
  purpose === "delete_account"
    ? brand
      ? `确认删除 ${brand} 账号`
      : "确认删除账号"
    : brand
      ? `${brand} 登录验证码`
      : "登录验证码";

const notice = (ctx: TemplateContext) =>
  ctx.purpose === "delete_account"
    ? `输入此验证码将永久删除你的账号，${ctx.ttlMinutes} 分钟内有效。如果这不是你的操作，请勿把验证码告诉任何人，并退出其他设备上的登录。`
    : `验证码 ${ctx.ttlMinutes} 分钟内有效。如果这不是你的操作，请忽略这封邮件。`;

export const zhTemplate: Required<EmailTemplate> = {
  subject: (ctx) => `${title(ctx)}：${ctx.code}`,
  html: (ctx) => `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;padding:24px;">
      <h2 style="margin:0 0 16px 0;">${title(ctx)}</h2>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0;">${ctx.code}</p>
      <p style="color:#666;font-size:14px;">${notice(ctx)}</p>
    </div>
  `,
  text: (ctx) =>
    ctx.purpose === "delete_account"
      ? `${title(ctx)}的验证码是 ${ctx.code}。${notice(ctx)}`
      : `你的${title(ctx)}是 ${ctx.code}，${ctx.ttlMinutes} 分钟内有效。`,
};
