const COOLDOWN_SECONDS = 60;
const EMAIL_WINDOW_SECONDS = 600;
const EMAIL_MAX_IN_WINDOW = 3;
const IP_WINDOW_SECONDS = 3600;
const IP_MAX_IN_WINDOW = 10;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function checkSendRateLimit(
  kv: KVNamespace,
  email: string,
  ip: string
): Promise<RateLimitResult> {
  const cooldown = await kv.get(`cooldown:${email}`);
  if (cooldown) {
    return { allowed: false, retryAfterSeconds: COOLDOWN_SECONDS };
  }
  const emailCount = parseInt((await kv.get(`rl:email:${email}`)) ?? "0", 10);
  if (emailCount >= EMAIL_MAX_IN_WINDOW) {
    return { allowed: false, retryAfterSeconds: EMAIL_WINDOW_SECONDS };
  }
  const ipCount = parseInt((await kv.get(`rl:ip:${ip}`)) ?? "0", 10);
  if (ipCount >= IP_MAX_IN_WINDOW) {
    return { allowed: false, retryAfterSeconds: IP_WINDOW_SECONDS };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function recordSend(
  kv: KVNamespace,
  email: string,
  ip: string
): Promise<void> {
  await kv.put(`cooldown:${email}`, "1", { expirationTtl: COOLDOWN_SECONDS });

  const emailKey = `rl:email:${email}`;
  const emailCount = parseInt((await kv.get(emailKey)) ?? "0", 10);
  await kv.put(emailKey, String(emailCount + 1), {
    expirationTtl: EMAIL_WINDOW_SECONDS,
  });

  const ipKey = `rl:ip:${ip}`;
  const ipCount = parseInt((await kv.get(ipKey)) ?? "0", 10);
  await kv.put(ipKey, String(ipCount + 1), { expirationTtl: IP_WINDOW_SECONDS });
}
