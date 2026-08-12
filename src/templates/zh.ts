import type { EmailTemplates } from "../email.js";

export function zhTemplates(brand?: string): EmailTemplates {
  const title = brand ? `${brand} 登录验证码` : "登录验证码";
  return {
    subject: (code) => `${title}：${code}`,
    html: (code) => `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;padding:24px;">
      <h2 style="margin:0 0 16px 0;">${title}</h2>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0;">${code}</p>
      <p style="color:#666;font-size:14px;">验证码 10 分钟内有效。如果这不是你的操作，请忽略这封邮件。</p>
    </div>
  `,
    text: (code) => `你的${title}是 ${code}，10 分钟内有效。`,
  };
}
