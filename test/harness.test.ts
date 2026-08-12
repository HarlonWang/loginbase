// 第 0 步冒烟测试：验证 miniflare 测试环境（D1/KV binding、vars）可用。
// 第 1 步平移 Tono 测试后，此文件保留作环境自检。
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("D1 binding 可用", async () => {
    const row = await env.DB.prepare("SELECT 1 AS one").first<{ one: number }>();
    expect(row?.one).toBe(1);
  });

  it("KV binding 可用", async () => {
    await env.EMAIL_CODES.put("smoke", "ok", { expirationTtl: 60 });
    expect(await env.EMAIL_CODES.get("smoke")).toBe("ok");
  });

  it("测试 vars 注入", () => {
    expect(env.JWT_SECRET).toBe("test-jwt-secret");
    expect(env.EMAIL_FROM_ADDRESS).toBeTruthy();
    expect(env.RESEND_API_KEY).toBeTruthy();
  });
});
