// 演示账号：应用商店审核用的固定凭据。见 LoginConfig.demoAccount。
// 每条用例对应商店的一项硬要求，改动时别只看"能登进去"就算过。
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createLogin } from "../src/index";
import { tonoLikeOnVerified, initDb, wipeKv } from "./helpers";

const DEMO_EMAIL = "store-review@example.com";
const DEMO_CODE = "424242";

const withDemo = createLogin<Cloudflare.Env>((e) => ({
  db: e.DB,
  kv: e.EMAIL_CODES,
  jwt: { secret: e.JWT_SECRET },
  email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS, brand: "Tono" },
  demoAccount: { email: DEMO_EMAIL, code: DEMO_CODE },
  onVerified: ({ email }) => tonoLikeOnVerified(email),
})).app;

// 对照组：同一套配置但不给 demoAccount——用来钉死「未配置即不存在」
const withoutDemo = createLogin<Cloudflare.Env>((e) => ({
  db: e.DB,
  kv: e.EMAIL_CODES,
  jwt: { secret: e.JWT_SECRET },
  email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS, brand: "Tono" },
  onVerified: ({ email }) => tonoLikeOnVerified(email),
})).app;

const post = (app: { request: typeof withDemo.request }, path: string, body: unknown) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "test-ua" },
      body: JSON.stringify(body),
    },
    env
  );

describe("演示账号（应用商店审核）", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
  });

  it("send 直接成功，且不落任何验证码到 KV——没有真实邮箱要收", async () => {
    const res = await post(withDemo, "/auth/code/send", { email: DEMO_EMAIL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cooldownSeconds: 0 });

    const keys = await env.EMAIL_CODES.list();
    expect(keys.keys).toHaveLength(0);
  });

  it("固定码可直接换会话，连 send 都不必先调", async () => {
    const res = await post(withDemo, "/auth/code/verify", {
      email: DEMO_EMAIL,
      code: DEMO_CODE,
    });
    expect(res.status).toBe(200);
    const data = await res.json<{ accessToken: string; refreshToken: string }>();
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
  });

  it("**可重复使用**：同一个码连登三次都成功（商店的硬要求，码不能焚）", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await post(withDemo, "/auth/code/verify", {
        email: DEMO_EMAIL,
        code: DEMO_CODE,
      });
      expect(res.status, `第 ${i + 1} 次登录`).toBe(200);
    }
  });

  it("**不受限流**：连发 5 次 send 全部放行（同邮箱窗口本是 10 分钟 3 次）", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post(withDemo, "/auth/code/send", { email: DEMO_EMAIL });
      expect(res.status, `第 ${i + 1} 次发送`).toBe(200);
    }
  });

  it("错误尝试不会作废演示码——审核员输错几次之后仍能登进去", async () => {
    for (let i = 0; i < 6; i++) {
      const bad = await post(withDemo, "/auth/code/verify", {
        email: DEMO_EMAIL,
        code: "000000",
      });
      expect(bad.status).toBe(400);
    }
    const ok = await post(withDemo, "/auth/code/verify", {
      email: DEMO_EMAIL,
      code: DEMO_CODE,
    });
    expect(ok.status).toBe(200);
  });

  it("码不对时回落常规路径的 code_expired，不泄露「这是演示账号」", async () => {
    const res = await post(withDemo, "/auth/code/verify", {
      email: DEMO_EMAIL,
      code: "999999",
    });
    expect(res.status).toBe(400);
    // 与「未发过码的普通邮箱」返回完全一致，无从区分
    expect(await res.json()).toEqual({ error: "code_expired" });
  });

  it("未配置 demoAccount 时这条路径不存在——同样的邮箱和码换不到会话", async () => {
    const res = await post(withoutDemo, "/auth/code/verify", {
      email: DEMO_EMAIL,
      code: DEMO_CODE,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "code_expired" });
  });

  it("邮箱比对大小写不敏感——审核员照抄时大小写不一致也能登", async () => {
    // 从常量派生而非另写字面量：改了 DEMO_EMAIL 却漏改这里的话，
    // 这条会静默变成「另一个邮箱登不进去」，测不到大小写这件事
    const res = await post(withDemo, "/auth/code/verify", {
      email: DEMO_EMAIL.toUpperCase(),
      code: DEMO_CODE,
    });
    expect(res.status).toBe(200);
  });

  it("演示账号不影响普通邮箱：普通邮箱仍需真码，固定码无效", async () => {
    const res = await post(withDemo, "/auth/code/verify", {
      email: "someone-else@example.com",
      code: DEMO_CODE,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "code_expired" });
  });
});
