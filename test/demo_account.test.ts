// 演示账号（docs/protocol.md「演示账号」）：唯一行为分叉在 /code/send——
// 码为固定值、不真实发信；其余（限流、存码、verify、建会话）必须与常规
// 账号走同一条路。这里既验证审核员流程可用，也验证「不存在鉴权旁路」。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createLogin, flushStats, MAX_ATTEMPTS } from "../src/index";
import { env, app, initDb, wipeKv, tonoLikeOnVerified } from "./helpers";

const DEMO_EMAIL = "demo.reviewer@example.com";
const DEMO_CODE = "246810";

// 独立实例：helpers 的共享 app 未配 demoAccount，正好充当「未配置」对照组。
// 邮箱故意带空格和大写，验证配置侧的归一化。
const demoLogin = createLogin<Cloudflare.Env>((e) => ({
  db: e.DB,
  kv: e.EMAIL_CODES,
  jwt: { secret: e.JWT_SECRET },
  email: {
    resendApiKey: e.RESEND_API_KEY,
    from: e.EMAIL_FROM_ADDRESS,
    brand: "Tono",
  },
  demoAccount: { email: `  ${DEMO_EMAIL.toUpperCase()}  `, code: DEMO_CODE },
  onVerified: ({ email }) => tonoLikeOnVerified(email),
}));
const demoApp = demoLogin.app;

function post(
  target: typeof demoApp,
  path: string,
  body: Record<string, unknown>,
  ip = "9.9.9.9"
) {
  return target.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(body),
    },
    env
  );
}

async function readEvents() {
  const { results } = await env.DB.prepare(
    "SELECT event, outcome, meta FROM auth_events ORDER BY id"
  ).all<{ event: string; outcome: string | null; meta: string | null }>();
  return results.map((r) => ({
    ...r,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
  }));
}

describe("演示账号", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await initDb();
    await wipeKv();
    await env.DB.prepare("DELETE FROM auth_events").run();
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it("未配置 demoAccount：同一组邮箱和码走常规路径，换不到会话", async () => {
    // 未发过码直接 verify → code_expired，与任意陌生邮箱一致
    const res = await post(app, "/auth/code/verify", {
      email: DEMO_EMAIL,
      code: DEMO_CODE,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "code_expired" });

    // send 会真实发信、码是随机的——固定码大概率验不过（若撞中也只是 1/1e6）
    await post(app, "/auth/code/send", { email: DEMO_EMAIL });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("send：200 且响应与常规相同、不发信、KV 里存的就是固定码", async () => {
    const res = await post(demoApp, "/auth/code/send", { email: DEMO_EMAIL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cooldownSeconds: 60 });
    expect(fetchSpy).not.toHaveBeenCalled();

    const stored = JSON.parse(
      (await env.EMAIL_CODES.get(`code:${DEMO_EMAIL}`)) ?? "null"
    ) as { code: string } | null;
    expect(stored?.code).toBe(DEMO_CODE);
    // cooldown 照常写入——限流对演示账号不豁免
    expect(await env.EMAIL_CODES.get(`cooldown:${DEMO_EMAIL}`)).toBe("1");
  });

  it("完整审核员流程：send → 固定码 verify → 拿到会话；码即焚，重登须重发", async () => {
    await post(demoApp, "/auth/code/send", { email: DEMO_EMAIL });
    const res = await post(demoApp, "/auth/code/verify", {
      email: `  ${DEMO_EMAIL.toUpperCase()}  `, // 请求侧归一化也要命中
      code: DEMO_CODE,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ accessToken?: string; refreshToken?: string }>();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();

    // 成功即焚（生产路径原样）：不重新 send 就再 verify，固定码也换不到会话
    expect(await env.EMAIL_CODES.get(`code:${DEMO_EMAIL}`)).toBeNull();
    const again = await post(demoApp, "/auth/code/verify", {
      email: DEMO_EMAIL,
      code: DEMO_CODE,
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "code_expired" });

    // 重新 send 后同一个码再次可用——商店要的「可重复使用」由此满足
    await wipeKv(); // 略过 60s 冷却（冷却本身在下个用例单独验证）
    await post(demoApp, "/auth/code/send", { email: DEMO_EMAIL });
    const rerun = await post(demoApp, "/auth/code/verify", {
      email: DEMO_EMAIL,
      code: DEMO_CODE,
    });
    expect(rerun.status).toBe(200);
  });

  it("send 限流照常生效：60s 内第 2 次 → 429", async () => {
    await post(demoApp, "/auth/code/send", { email: DEMO_EMAIL });
    const res = await post(demoApp, "/auth/code/send", { email: DEMO_EMAIL });
    expect(res.status).toBe(429);
  });

  it("防暴破照常生效：错码计次，第 5 次即焚", async () => {
    await post(demoApp, "/auth/code/send", { email: DEMO_EMAIL });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const res = await post(demoApp, "/auth/code/verify", {
        email: DEMO_EMAIL,
        code: "000000",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_code" });
    }
    const burned = await post(demoApp, "/auth/code/verify", {
      email: DEMO_EMAIL,
      code: "000000",
    });
    expect(burned.status).toBe(429);
    expect(await env.EMAIL_CODES.get(`code:${DEMO_EMAIL}`)).toBeNull();

    // 焚毁后连正确的固定码也进不来——没有旁路
    const after = await post(demoApp, "/auth/code/verify", {
      email: DEMO_EMAIL,
      code: DEMO_CODE,
    });
    expect(after.status).toBe(400);
    expect(await after.json()).toEqual({ error: "code_expired" });
  });

  it("统计事件带 meta.demo，常规邮箱不带", async () => {
    await post(demoApp, "/auth/code/send", { email: DEMO_EMAIL });
    await post(demoApp, "/auth/code/verify", { email: DEMO_EMAIL, code: DEMO_CODE });
    await post(demoApp, "/auth/code/send", { email: "real@example.com" }, "8.8.8.8");
    await flushStats();

    const events = await readEvents();
    const demoEvents = events.filter((e) => e.meta?.demo === true);
    expect(demoEvents.map((e) => `${e.event}:${e.outcome ?? ""}`)).toEqual([
      "code_sent:",
      "code_verify:ok",
      "login:",
    ]);
    const realSend = events.find(
      (e) => e.event === "code_sent" && e.meta?.demo !== true
    );
    expect(realSend).toBeTruthy();
  });
});
