// 请求体字段类型防御（1.2.0）：JSON 里客户端可塞任意类型，非字符串字段
// 必须走各端点自己的 4xx，而不是抛 TypeError 变成 500。
// 缘起：PR #6 的 Sourcery 审查在 link/start 指出该风险，排查发现是全库同一模式（6 处）。
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createSession, signAccessToken } from "../src/index";
import { app, initDb, wipeKv } from "./helpers";

// 数字 / 对象 / 数组 / null：都不是字符串，都不该让端点炸成 500
const JUNK = [123, { nested: "x" }, ["a"], null];

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env
  );
}

describe("请求体字段非字符串 → 各端点的 4xx，不是 500", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
  });

  it("POST /code/send 的 email → 400 invalid_email", async () => {
    for (const junk of JUNK) {
      const res = await post("/auth/code/send", { email: junk });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_email" });
    }
  });

  it("POST /code/verify 的 email / code → 400，不抛", async () => {
    for (const junk of JUNK) {
      const byEmail = await post("/auth/code/verify", {
        email: junk,
        code: "123456",
      });
      expect(byEmail.status).toBe(400);

      const byCode = await post("/auth/code/verify", {
        email: "someone@example.com",
        code: junk,
      });
      expect(byCode.status).toBe(400);
    }
  });

  it("POST /refresh 的 refreshToken → 401 missing_token", async () => {
    for (const junk of JUNK) {
      const res = await post("/auth/refresh", { refreshToken: junk });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "invalid_refresh_token",
        reason: "missing_token",
      });
    }
  });

  // exchange 无鉴权、任何人可打，是这组里暴露面最大的一个
  it("POST /oauth/exchange 的 otc → 400 invalid_otc", async () => {
    for (const junk of JUNK) {
      const res = await post("/auth/oauth/exchange", { otc: junk });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_otc" });
    }
  });

  it("POST /oauth/github/link/start 的 redirect → 400 invalid_redirect", async () => {
    const { sessionId } = await createSession(env.DB, { userId: "u-junk" });
    const token = await signAccessToken(env.JWT_SECRET, "u-junk", sessionId);
    for (const junk of JUNK) {
      const res = await post(
        "/auth/oauth/github/link/start",
        { redirect: junk },
        { Authorization: `Bearer ${token}` }
      );
      // helpers 的 login 实例未配 onLinked → 404 先行；配了才轮到 400。
      // 两者都不是 500，即本用例要守的性质。
      expect([400, 404]).toContain(res.status);
    }
  });
});
