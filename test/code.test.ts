import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  generateCode,
  storeCode,
  readCode,
  deleteCode,
  incrementAttempts,
} from "../src/code";

async function wipeKv() {
  const list = await env.EMAIL_CODES.list();
  for (const key of list.keys) await env.EMAIL_CODES.delete(key.name);
}

describe("code", () => {
  beforeEach(wipeKv);

  it("generateCode 返回 6 位纯数字字符串", () => {
    for (let i = 0; i < 100; i++) {
      const c = generateCode();
      expect(c).toMatch(/^\d{6}$/);
    }
  });

  it("storeCode 写入后 readCode 取得原始载荷", async () => {
    await storeCode(env.EMAIL_CODES, "u@x.com", "123456");
    const s = await readCode(env.EMAIL_CODES, "u@x.com");
    expect(s).not.toBeNull();
    expect(s!.code).toBe("123456");
    expect(s!.attempts).toBe(0);
    expect(typeof s!.issuedAt).toBe("number");
  });

  it("deleteCode 后 readCode 返回 null", async () => {
    await storeCode(env.EMAIL_CODES, "u@x.com", "123456");
    await deleteCode(env.EMAIL_CODES, "u@x.com");
    expect(await readCode(env.EMAIL_CODES, "u@x.com")).toBeNull();
  });

  it("incrementAttempts 保留原 issuedAt 并累加", async () => {
    await storeCode(env.EMAIL_CODES, "u@x.com", "123456");
    const stored = (await readCode(env.EMAIL_CODES, "u@x.com"))!;
    const n1 = await incrementAttempts(env.EMAIL_CODES, "u@x.com", stored);
    const n2 = await incrementAttempts(
      env.EMAIL_CODES,
      "u@x.com",
      (await readCode(env.EMAIL_CODES, "u@x.com"))!
    );
    expect(n1).toBe(1);
    expect(n2).toBe(2);
    const again = (await readCode(env.EMAIL_CODES, "u@x.com"))!;
    expect(again.issuedAt).toBe(stored.issuedAt);
  });
});
