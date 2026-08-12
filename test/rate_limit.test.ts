import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { checkSendRateLimit, recordSend } from "../src/rate_limit";

async function wipeKv() {
  const list = await env.EMAIL_CODES.list();
  for (const key of list.keys) await env.EMAIL_CODES.delete(key.name);
}

describe("rate_limit", () => {
  beforeEach(wipeKv);

  it("首次请求允许通过", async () => {
    const r = await checkSendRateLimit(env.EMAIL_CODES, "a@x.com", "1.2.3.4");
    expect(r.allowed).toBe(true);
  });

  it("60 秒 cooldown 命中 → 不允许", async () => {
    await recordSend(env.EMAIL_CODES, "a@x.com", "1.2.3.4");
    const r = await checkSendRateLimit(env.EMAIL_CODES, "a@x.com", "1.2.3.4");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(60);
  });

  it("同一邮箱 10 分钟内第 4 次被拒", async () => {
    for (let i = 0; i < 3; i++) {
      await recordSend(env.EMAIL_CODES, "b@x.com", `ip${i}`);
      await env.EMAIL_CODES.delete("cooldown:b@x.com");
    }
    const r = await checkSendRateLimit(env.EMAIL_CODES, "b@x.com", "ip-new");
    expect(r.allowed).toBe(false);
  });

  it("同一 IP 1 小时内第 11 次被拒", async () => {
    for (let i = 0; i < 10; i++) {
      await recordSend(env.EMAIL_CODES, `mail${i}@x.com`, "9.9.9.9");
    }
    const r = await checkSendRateLimit(env.EMAIL_CODES, "another@x.com", "9.9.9.9");
    expect(r.allowed).toBe(false);
  });
});
