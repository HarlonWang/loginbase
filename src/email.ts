const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailConfig {
  resendApiKey: string;
  from: string;
}

export async function sendCodeEmail(
  config: EmailConfig,
  email: string,
  code: string
): Promise<void> {
  const body = {
    from: config.from,
    to: [email],
    subject: `Your Tono verification code: ${code}`,
    html: renderHtml(code),
    text: renderText(code),
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

function renderHtml(code: string): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;">
      <h2 style="margin:0 0 16px 0;">Your Tono verification code</h2>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0;">${code}</p>
      <p style="color:#666;font-size:14px;">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
    </div>
  `;
}

function renderText(code: string): string {
  return `Your Tono verification code is ${code}. It expires in 10 minutes.`;
}
