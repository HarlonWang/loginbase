import type { EmailTemplates } from "../email.js";

// en 模板即 Tono 生产模板的 brand 参数化：brand="Tono" 时输出与平移前逐字节一致。
export function enTemplates(brand?: string): EmailTemplates {
  const title = brand ? `Your ${brand} verification code` : "Your verification code";
  return {
    subject: (code) => `${title}: ${code}`,
    html: (code) => `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;">
      <h2 style="margin:0 0 16px 0;">${title}</h2>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0;">${code}</p>
      <p style="color:#666;font-size:14px;">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
    </div>
  `,
    text: (code) => `${title} is ${code}. It expires in 10 minutes.`,
  };
}
