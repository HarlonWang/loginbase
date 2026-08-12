import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { signAccessToken, verifyAccessToken, ACCESS_TTL_SECONDS } from "../src/token";

describe("token", () => {
  it("签发的 access JWT 含 sub / sid / exp", async () => {
    const token = await signAccessToken(env.JWT_SECRET, "u-1", "s-1");
    const payload = await verifyAccessToken(env.JWT_SECRET, token);
    expect(payload.sub).toBe("u-1");
    expect(payload.sid).toBe("s-1");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(payload.exp! - payload.iat!).toBe(ACCESS_TTL_SECONDS);
  });

  it("签名错误 → 抛错", async () => {
    const token = await signAccessToken(env.JWT_SECRET, "u-1", "s-1");
    await expect(verifyAccessToken("wrong-secret", token)).rejects.toThrow();
  });
});
