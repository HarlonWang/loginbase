// 演示账号：应用商店审核用的固定凭据。见 LoginConfig.demoAccount。
// 每条用例对应商店的一项硬要求，改动时别只看"能登进去"就算过。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createLogin } from "../src/index";
import { tonoLikeOnVerified, initDb, wipeKv } from "./helpers";
import { storeCode, readCode } from "../src/code";
import { Hono } from "hono";
import { registerDemoAccount } from "../src/demo";
import { createTracker } from "../src/stats";
import type { LoginConfig } from "../src/config";
import type { AuthVariables } from "../src/middleware";

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

    const keys = await env.EMAIL_CODES.list();
    expect(keys.keys).toHaveLength(0);
  });

  it("send 的响应与普通邮箱**逐字节相同**——否则一次请求就能认出演示账号", async () => {
    // 普通邮箱那条要真发信才会 200，故与既有 send 测试一样打桩 fetch
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    try {
      const demoRes = await post(withDemo, "/auth/code/send", { email: DEMO_EMAIL });
      const normalRes = await post(withDemo, "/auth/code/send", {
        email: "someone-else@example.com",
      });

      expect(demoRes.status).toBe(normalRes.status);
      expect(await demoRes.json()).toEqual(await normalRes.json());
      // 顺带钉死：演示邮箱那条**没有**触发发信，普通邮箱那条有
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
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

  it("演示邮箱输错码时**完全不碰 KV**——不读、不计错误、不删残留的普通验证码", async () => {
    // 现实场景：启用 demoAccount 之前，这个邮箱正常走过一次登录，KV 里留着码。
    // 若错码落到常规路径，会返回 invalid_code / too_many_attempts（泄露此邮箱不一般），
    // 并把这条记录改掉甚至删掉（PR #9 审查抓出的那条）
    await storeCode(env.EMAIL_CODES, DEMO_EMAIL, "111111");

    // 错 6 次——常规路径第 5 次就会 429 并焚码
    for (let i = 0; i < 6; i++) {
      const bad = await post(withDemo, "/auth/code/verify", {
        email: DEMO_EMAIL,
        code: "000000",
      });
      expect(bad.status, `第 ${i + 1} 次`).toBe(400);
      expect(await bad.json()).toEqual({ error: "code_expired" });
    }

    const survived = await readCode(env.EMAIL_CODES, DEMO_EMAIL);
    expect(survived?.code, "残留的普通码不该被删或改").toBe("111111");
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

  it("注册顺序守卫：挪到路由之后会**静默失效**，所以 handler 里那句约束不是废话", async () => {
    // Hono 后注册的 use 拦不住已注册的 handler。这个约束只靠注释守着太脆——
    // 挪错位置不会报错，只会让演示账号退化成一个登不进去的普通邮箱。
    // 这条用例把「错误顺序确实会失效」钉成事实；哪天 Hono 改了行为它会转红，
    // 提醒去掉 handler.ts 里那段约束说明。
    const resolve = (e: Cloudflare.Env) =>
      ({
        db: e.DB,
        kv: e.EMAIL_CODES,
        jwt: { secret: e.JWT_SECRET },
        email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
        demoAccount: { email: DEMO_EMAIL, code: DEMO_CODE },
        onVerified: () => ({ userId: "u-order" }),
      }) as LoginConfig;

    const auth = new Hono<{ Variables: AuthVariables }>().basePath("/auth");
    auth.post("/code/verify", (c) => c.json({ reached: "handler" }));
    registerDemoAccount(auth, resolve, createTracker(resolve)); // 故意后注册

    const res = await auth.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: DEMO_EMAIL, code: DEMO_CODE }),
      },
      env
    );
    expect(await res.json()).toEqual({ reached: "handler" });
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
