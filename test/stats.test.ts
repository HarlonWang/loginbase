// 登录统计落库测试（v1，方案见 docs/stats-design.md）。
// 第一原则的守门测试在最上面：**表不存在时登录必须照常成功**。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { createLogin, storeCode, flushStats } from "../src/index";
import type { LoginConfig } from "../src/index";
import { initDb, wipeKv, createTestUser } from "./helpers";

function makeLogin(overrides: Partial<LoginConfig> = {}) {
  return createLogin<Cloudflare.Env>((e) => ({
    db: e.DB,
    kv: e.EMAIL_CODES,
    jwt: { secret: e.JWT_SECRET },
    email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
    socials: {
      github: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        allowedRedirects: ["testapp://auth"],
      },
    },
    onVerified: () => ({ userId: "u-stats", isNewUser: true }),
    ...overrides,
  }));
}

interface EventRow {
  event: string;
  outcome: string | null;
  provider: string | null;
  user_id: string | null;
  flow_id: string | null;
  is_new_user: number | null;
  country: string | null;
  asn: number | null;
  colo: string | null;
  timezone: string | null;
  city: string | null;
  region: string | null;
  source: string;
  meta: string | null;
}

async function rows(): Promise<EventRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM auth_events ORDER BY id"
  ).all<EventRow>();
  return results;
}

async function wipeEvents() {
  await env.DB.prepare("DELETE FROM auth_events").run();
}

async function verify(app: ReturnType<typeof makeLogin>["app"], email: string) {
  await storeCode(env.EMAIL_CODES, email, "123456");
  return app.request(
    "/auth/code/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: "123456" }),
    },
    env
  );
}

beforeEach(async () => {
  await initDb();
  await wipeKv();
  await wipeEvents();
});

describe("fail-safe：统计绝不能成为登录的故障源", () => {
  it("auth_events 不存在时登录照常成功，且只告警一次", async () => {
    const events: Record<string, unknown>[] = [];
    // 独立实例 = 独立 config 对象，告警的 once 记忆化不被其它用例污染
    const { app } = makeLogin({ onEvent: (e) => events.push(e) });
    await env.DB.prepare("DROP TABLE IF EXISTS auth_events").run();

    const res = await verify(app, "nodb@example.com");
    expect(res.status).toBe(200); // 登录不受影响
    await flushStats();

    const warnings = events.filter((e) => e.event === "stats_unavailable");
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0].hint)).toContain("migration 0002");

    // 第二次请求不再刷屏
    await verify(app, "nodb2@example.com");
    await flushStats();
    expect(events.filter((e) => e.event === "stats_unavailable")).toHaveLength(1);

    await initDb(); // 复原，供后续用例
  });

  it("enabled: false 时一条都不写", async () => {
    const { app } = makeLogin({ stats: { enabled: false } });
    const res = await verify(app, "off@example.com");
    expect(res.status).toBe(200);
    await flushStats();
    expect(await rows()).toHaveLength(0);
  });
});

describe("邮箱验证码链路", () => {
  it("验码成功写 code_verify(ok) 与 login", async () => {
    const { app } = makeLogin();
    await verify(app, "ok@example.com");
    await flushStats();

    const all = await rows();
    expect(all.map((r) => `${r.event}:${r.outcome ?? ""}`)).toEqual([
      "code_verify:ok",
      "login:",
    ]);
    const login = all[1];
    expect(login.provider).toBe("email");
    expect(login.user_id).toBe("u-stats");
    expect(login.is_new_user).toBe(1);
    expect(login.source).toBe("server");
    // 测试请求没有 cf：country 兜底成 unknown，其余地理字段一律 null
    expect(login.country).toBe("unknown");
    expect([login.asn, login.colo, login.timezone, login.city, login.region]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("cf 存在时六个地理字段全部落库", async () => {
    const { app } = makeLogin();
    await storeCode(env.EMAIL_CODES, "geo@example.com", "123456");
    const req = new Request("http://local/auth/code/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "geo@example.com", code: "123456" }),
      // Cloudflare 边缘在请求到达 Worker 前填好的字段，这里模拟之
      cf: {
        country: "CN",
        asn: 4134,
        colo: "HKG",
        timezone: "Asia/Shanghai",
        city: "Hangzhou",
        region: "Zhejiang",
      },
    } as RequestInit);

    expect((await app.fetch(req, env)).status).toBe(200);
    await flushStats();

    const login = (await rows()).find((r) => r.event === "login")!;
    expect({
      country: login.country,
      asn: login.asn,
      colo: login.colo,
      timezone: login.timezone,
      city: login.city,
      region: login.region,
    }).toEqual({
      country: "CN",
      asn: 4134,
      colo: "HKG",
      timezone: "Asia/Shanghai",
      city: "Hangzhou",
      region: "Zhejiang",
    });
  });

  it("三个失败分支各记各的 outcome", async () => {
    const { app } = makeLogin();
    const post = (body: unknown) =>
      app.request(
        "/auth/code/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        env
      );

    // 码不存在（过期 / 已焚 / 从未发过 / 已用过，KV 层不可再分）
    await post({ email: "none@example.com", code: "123456" });
    // 码错
    await storeCode(env.EMAIL_CODES, "bad@example.com", "123456");
    await post({ email: "bad@example.com", code: "000000" });
    // 连错 5 次即焚
    await storeCode(env.EMAIL_CODES, "burn@example.com", "123456");
    for (let i = 0; i < 5; i++) await post({ email: "burn@example.com", code: "000000" });
    await flushStats();

    const outcomes = (await rows())
      .filter((r) => r.event === "code_verify")
      .map((r) => r.outcome);
    expect(outcomes[0]).toBe("code_not_found");
    expect(outcomes[1]).toBe("invalid_code");
    expect(outcomes[outcomes.length - 1]).toBe("too_many_attempts");
  });

  it("onVerified 抛错记 internal", async () => {
    const { app } = makeLogin({
      onVerified: () => {
        throw new Error("boom");
      },
    });
    const res = await verify(app, "hookfail@example.com");
    expect(res.status).toBe(500);
    await flushStats();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].outcome).toBe("internal");
  });

  it("code_sent 落库，且给 onEvent 的形态与 1.3.0 一致", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const events: Record<string, unknown>[] = [];
    const { app } = makeLogin({ onEvent: (e) => events.push(e) });

    await app.request(
      "/auth/code/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "sent@example.com" }),
      },
      env
    );
    await flushStats();

    expect((await rows()).map((r) => r.event)).toEqual(["code_sent"]);
    expect(events.find((e) => e.event === "code_sent")).toEqual({
      event: "code_sent",
      locale: { resolved: "en" },
    });
    fetchSpy.mockRestore();
  });

  it("发信失败记 code_send_failed，错误串进 meta", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
    const { app } = makeLogin();

    const res = await app.request(
      "/auth/code/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "failsend@example.com" }),
      },
      env
    );
    expect(res.status).toBe(500);
    await flushStats();

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].event).toBe("code_send_failed");
    expect(String(all[0].meta)).toContain("500");
    fetchSpy.mockRestore();
  });
});

describe("限流与主动登出", () => {
  it("限流命中按层记录（cooldown / email / ip）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const { app } = makeLogin();
    const send = (email: string) =>
      app.request(
        "/auth/code/send",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        },
        env
      );

    await send("rl@example.com"); // 首次通过，写下 60s cooldown
    const blocked = await send("rl@example.com");
    expect(blocked.status).toBe(429);
    await flushStats();

    const limited = (await rows()).filter((r) => r.event === "rate_limited");
    expect(limited).toHaveLength(1);
    expect(limited[0].outcome).toBe("cooldown"); // 分层可辨，不靠 retryAfterSeconds 反推
    expect(JSON.parse(String(limited[0].meta)).endpoint).toBe("code_send");
    fetchSpy.mockRestore();
  });

  it("主动登出记 session_revoked，current 与 all 分开", async () => {
    const { app } = makeLogin();
    const user = await createTestUser("logout@example.com");
    const headers = {
      Authorization: `Bearer ${user.accessToken}`,
      "Content-Type": "application/json",
    };

    expect((await app.request("/auth/sessions", { method: "DELETE", headers }, env)).status).toBe(204);
    expect(
      (await app.request("/auth/sessions/all", { method: "DELETE", headers }, env)).status
    ).toBe(204);
    await flushStats();

    const revoked = (await rows()).filter((r) => r.event === "session_revoked");
    expect(revoked.map((r) => r.outcome)).toEqual(["current", "all"]);
    expect(revoked[0].user_id).toBe(user.userId);
  });
});

describe("OAuth 漏斗", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gh-token" }), { status: 200 });
      }
      if (url.startsWith("https://api.github.com/user/emails")) {
        return new Response(
          JSON.stringify([{ email: "octo@example.com", primary: true, verified: true }]),
          { status: 200 }
        );
      }
      if (url.startsWith("https://api.github.com/user")) {
        return new Response(JSON.stringify({ id: 42, login: "octocat" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  afterEach(() => fetchSpy.mockRestore());

  it("start → callback → exchange 三段共享同一 flow_id，并产出 login", async () => {
    const { app } = makeLogin();

    const start = await app.request(
      "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth",
      { method: "GET" },
      env
    );
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;

    const cb = await app.request(
      `/auth/oauth/github/callback?code=gh-code&state=${state}`,
      { method: "GET" },
      env
    );
    const otc = new URL(cb.headers.get("Location")!).searchParams.get("otc")!;

    const ex = await app.request(
      "/auth/oauth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otc }),
      },
      env
    );
    expect(ex.status).toBe(200);
    await flushStats();

    const all = await rows();
    expect(all.map((r) => `${r.event}:${r.outcome ?? ""}`)).toEqual([
      "oauth_start:ok",
      "oauth_callback:issued",
      "oauth_exchange:ok",
      "login:",
    ]);
    const flowIds = new Set(all.map((r) => r.flow_id));
    expect(flowIds.size).toBe(1); // 四条事件串在同一次流程上
    expect([...flowIds][0]).not.toBe(state); // 绝不能拿单次凭证当串联标识
    expect(all[3].provider).toBe("github");
    expect(all[3].user_id).toBe("u-stats");
  });

  it("start 与 callback 把浏览器 UA 记进 meta，exchange 不记", async () => {
    const { app } = makeLogin();
    const browserHeaders = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) Chrome/137.0.0.0 Mobile Safari/537.36",
      "sec-ch-ua": '"Chromium";v="137", "Brave";v="137", "Not/A)Brand";v="24"',
    };
    const start = await app.request(
      "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth",
      { method: "GET", headers: browserHeaders },
      env
    );
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const cb = await app.request(
      `/auth/oauth/github/callback?code=gh-code&state=${state}`,
      { method: "GET", headers: browserHeaders },
      env
    );
    const otc = new URL(cb.headers.get("Location")!).searchParams.get("otc")!;
    await app.request(
      "/auth/oauth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otc }),
      },
      env
    );
    await flushStats();

    const all = await rows();
    const metaOf = (event: string) =>
      JSON.parse(String(all.find((r) => r.event === event)!.meta)) as Record<string, unknown>;
    expect(metaOf("oauth_start").ua).toContain("Chrome/137");
    expect(metaOf("oauth_start").secChUa).toContain("Brave"); // UA 同 Chrome 的套壳靠品牌列表区分
    expect(metaOf("oauth_callback").ua).toContain("Chrome/137"); // issued 行也是 oauth_callback
    expect(all.find((r) => r.event === "oauth_exchange")!.meta).toBeNull();
  });

  it("start 的客户端自述参数随 state 透传全链，且不进 exchange 响应体", async () => {
    const { app } = makeLogin();
    const start = await app.request(
      "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth" +
        "&browser_tier=custom_tab&browser_pkg=com.android.chrome&client_flow_id=cf-123_A",
      { method: "GET" },
      env
    );
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const cb = await app.request(
      `/auth/oauth/github/callback?code=gh-code&state=${state}`,
      { method: "GET" },
      env
    );
    const otc = new URL(cb.headers.get("Location")!).searchParams.get("otc")!;
    const ex = await app.request(
      "/auth/oauth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otc }),
      },
      env
    );
    const body = (await ex.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["accessToken", "isNewUser", "refreshToken"]);
    await flushStats();

    const all = await rows();
    for (const event of ["oauth_start", "oauth_callback", "oauth_exchange", "login"]) {
      const meta = JSON.parse(String(all.find((r) => r.event === event)!.meta)) as Record<
        string,
        unknown
      >;
      expect(meta.browserTier, event).toBe("custom_tab");
      expect(meta.browserPkg, event).toBe("com.android.chrome");
      expect(meta.clientFlowId, event).toBe("cf-123_A");
    }
  });

  it("非法的客户端自述参数静默丢弃，登录照常", async () => {
    const { app } = makeLogin();
    const start = await app.request(
      "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth" +
        "&browser_tier=webview&browser_pkg=bad%20pkg%21&client_flow_id=" +
        "x".repeat(65),
      { method: "GET" },
      env
    );
    expect(start.status).toBe(302);
    await flushStats();
    const all = await rows();
    const meta = all.find((r) => r.event === "oauth_start")!.meta;
    if (meta !== null) {
      const parsed = JSON.parse(String(meta)) as Record<string, unknown>;
      expect(parsed.browserTier).toBeUndefined();
      expect(parsed.browserPkg).toBeUndefined();
      expect(parsed.clientFlowId).toBeUndefined();
    }
  });

  it("超长 UA 截断到 256 字符", async () => {
    const { app } = makeLogin();
    await app.request(
      "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth",
      { method: "GET", headers: { "User-Agent": "x".repeat(1000) } },
      env
    );
    await flushStats();
    const all = await rows();
    const meta = JSON.parse(String(all[0].meta)) as Record<string, string>;
    expect(meta.ua).toHaveLength(256);
  });

  it("exchange 响应体不含内部字段（协议形态不变）", async () => {
    const { app } = makeLogin();
    const start = await app.request(
      "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth",
      { method: "GET" },
      env
    );
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const cb = await app.request(
      `/auth/oauth/github/callback?code=gh-code&state=${state}`,
      { method: "GET" },
      env
    );
    const otc = new URL(cb.headers.get("Location")!).searchParams.get("otc")!;
    const ex = await app.request(
      "/auth/oauth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otc }),
      },
      env
    );
    const body = (await ex.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["accessToken", "isNewUser", "refreshToken"]);
  });

  it("state 失效时记 invalid_state，且没有 flow_id", async () => {
    const { app } = makeLogin();
    const res = await app.request(
      "/auth/oauth/github/callback?code=gh-code&state=gone",
      { method: "GET" },
      env
    );
    expect(res.status).toBe(400);
    await flushStats();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].outcome).toBe("invalid_state");
    expect(all[0].flow_id).toBeNull();
  });

  it("invalid_otc 与「回跳没到达」分开记", async () => {
    const { app } = makeLogin();
    await app.request(
      "/auth/oauth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otc: "expired" }),
      },
      env
    );
    await flushStats();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(`${all[0].event}:${all[0].outcome}`).toBe("oauth_exchange:invalid_otc");
  });
});

describe("refresh", () => {
  it("成功续期写 ok（F2 的分母），救活事件形态与 1.3.0 一致", async () => {
    const events: Record<string, unknown>[] = [];
    const { app } = makeLogin({ onEvent: (e) => events.push(e) });
    const user = await createTestUser("refresh-stats@example.com");

    const post = (refreshToken: string) =>
      app.request(
        "/auth/refresh",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
          body: JSON.stringify({ refreshToken }),
        },
        env
      );

    const first = await post(user.refreshToken);
    expect(first.status).toBe(200);
    // 旧 token 再次提交 → 丢回执救活
    const again = await post(user.refreshToken);
    expect(again.status).toBe(200);
    await flushStats();

    const refreshRows = (await rows()).filter((r) => r.event === "refresh");
    expect(refreshRows.map((r) => r.outcome)).toEqual(["ok", "rescued"]);
    expect(refreshRows[0].user_id).toBe(user.userId);
    expect(JSON.parse(String(refreshRows[0].meta)).familyId).toBeTruthy();

    // onEvent 侧：字段与 1.3.0 完全一致（familyId / ip 摊平，ip 不落表）
    const rescued = events.find((e) => e.outcome === "rescued")!;
    expect(Object.keys(rescued).sort()).toEqual([
      "event",
      "familyId",
      "ip",
      "outcome",
      "userId",
    ]);
    expect(rescued.ip).toBe("9.9.9.9");
    const rescuedRow = refreshRows[1];
    expect(String(rescuedRow.meta)).not.toContain("9.9.9.9"); // ip 不入库
  });
});
