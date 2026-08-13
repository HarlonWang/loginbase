// github-oauth 插件测试（第 2 步新增）：start / callback / exchange 全流程，
// GitHub API 以 fetch mock 拦截；协议契约见 docs/protocol.md「GitHub OAuth」节。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { createLogin } from "../src/index";
import type { VerifiedIdentity } from "../src/index";
import { app, initDb, wipeKv } from "./helpers";

function mockGithub(fetchSpy: ReturnType<typeof vi.spyOn>, opts: {
  token?: string | null;
  userId?: number;
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>;
} = {}) {
  const { token = "gh-token", userId = 12345, emails } = opts;
  fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify(token ? { access_token: token } : {}), {
        status: 200,
      });
    }
    if (url.startsWith("https://api.github.com/user/emails")) {
      return new Response(
        JSON.stringify(
          emails ?? [
            { email: "Octo@Example.com", primary: true, verified: true },
            { email: "alt@example.com", primary: false, verified: true },
          ]
        ),
        { status: 200 }
      );
    }
    if (url.startsWith("https://api.github.com/user")) {
      return new Response(
        JSON.stringify({
          id: userId,
          login: "octocat",
          avatar_url: "https://a.png",
          two_factor_authentication: true, // 敏感字段，断言被白名单剔除
          total_private_repos: 5,
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function startAndGetState(): Promise<string> {
  const res = await app.request(
    "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth%2Fcallback",
    { method: "GET" },
    env
  );
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("Location")!);
  return loc.searchParams.get("state")!;
}

describe("GET /auth/oauth/github/start", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
  });

  it("白名单 redirect → 302 GitHub authorize，state 落 KV", async () => {
    const res = await app.request(
      "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth%2Fcallback",
      { method: "GET" },
      env
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("scope")).toBe("user:email");
    expect(loc.searchParams.get("redirect_uri")).toMatch(/\/auth\/oauth\/github\/callback$/);
    const state = loc.searchParams.get("state")!;
    expect(await env.EMAIL_CODES.get(`oauth:state:${state}`)).not.toBeNull();
  });

  it("缺 redirect / 不在白名单 → 400 invalid_redirect", async () => {
    for (const qs of ["", "?redirect=evil%3A%2F%2Fphish"]) {
      const res = await app.request(
        `/auth/oauth/github/start${qs}`,
        { method: "GET" },
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_redirect" });
    }
  });
});

describe("GET /auth/oauth/github/callback + POST /auth/oauth/exchange", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await initDb();
    await wipeKv();
    await env.DB.prepare("DELETE FROM sessions").run();
    await env.DB.prepare("DELETE FROM users").run();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  async function callback(state: string, code = "gh-code") {
    return app.request(
      `/auth/oauth/github/callback?code=${code}&state=${state}`,
      { method: "GET", headers: { "User-Agent": "oauth-ua", "CF-Connecting-IP": "8.8.8.8" } },
      env
    );
  }

  it("全流程：callback 发 otc（token 不进 URL），exchange 兑换 token 对，两者均单次使用", async () => {
    const state = await startAndGetState();
    mockGithub(fetchSpy);

    const cb = await callback(state);
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get("Location")!);
    expect(loc.protocol).toBe("testapp:");
    const otc = loc.searchParams.get("otc")!;
    expect(otc).toBeTruthy();
    // token 不在 URL 上
    expect(cb.headers.get("Location")).not.toContain("accessToken");

    // state 单次使用：同 state 再来 → invalid_state
    const replay = await callback(state);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_state" });

    // exchange
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
    const body = await ex.json<{
      accessToken: string;
      refreshToken: string;
      isNewUser: boolean;
      user: { email: string };
    }>();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.isNewUser).toBe(true);
    // 夹具钩子收到归一化 email（GitHub 返回的是 Octo@Example.com）
    expect(body.user.email).toBe("octo@example.com");

    // otc 单次使用
    const ex2 = await app.request(
      "/auth/oauth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otc }),
      },
      env
    );
    expect(ex2.status).toBe(400);
    expect(await ex2.json()).toEqual({ error: "invalid_otc" });
  });

  it("state 无效 → 400 invalid_state", async () => {
    const res = await callback("not-a-real-state");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_state" });
  });

  it("GitHub 换码失败 → 302 redirect?error=oauth_failed", async () => {
    const state = await startAndGetState();
    mockGithub(fetchSpy, { token: null });
    const res = await callback(state);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe(
      "oauth_failed"
    );
  });

  it("无 verified 邮箱 → 302 redirect?error=oauth_no_email", async () => {
    const state = await startAndGetState();
    mockGithub(fetchSpy, {
      emails: [{ email: "x@x.com", primary: true, verified: false }],
    });
    const res = await callback(state);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe(
      "oauth_no_email"
    );
  });

  it("exchange 传垃圾 otc → 400 invalid_otc", async () => {
    const res = await app.request(
      "/auth/oauth/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otc: "garbage" }),
      },
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_otc" });
  });
});

describe("redirect 白名单结构化校验（防开放重定向）", () => {
  const httpsLogin = createLogin<Cloudflare.Env>((e) => ({
    db: e.DB,
    kv: e.EMAIL_CODES,
    jwt: { secret: e.JWT_SECRET },
    email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
    socials: {
      github: {
        clientId: "cid",
        clientSecret: "cs",
        allowedRedirects: ["https://app.example.com/cb"],
      },
    },
    onVerified: () => ({ userId: "u-1" }),
  }));

  async function start(redirect: string) {
    return httpsLogin.app.request(
      `/auth/oauth/github/start?redirect=${encodeURIComponent(redirect)}`,
      { method: "GET" },
      env
    );
  }

  it("scheme+host 精确、path 前缀扩展 → 允许", async () => {
    expect((await start("https://app.example.com/cb")).status).toBe(302);
    expect((await start("https://app.example.com/cb/deeper?x=1")).status).toBe(302);
  });

  it("子域伪装 / 换 host / 非法 URL → 400", async () => {
    for (const evil of [
      "https://app.example.com.evil.com/cb", // startsWith 时代可绕过的经典载荷
      "https://evil.com/https://app.example.com/cb",
      "http://app.example.com/cb", // scheme 降级
      "not a url",
    ]) {
      const res = await start(evil);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_redirect" });
    }
  });
});

describe("onVerified 契约（github provider）", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await initDb();
    await wipeKv();
    await env.DB.prepare("DELETE FROM sessions").run();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  it("钩子收到 provider=github、providerUserId、归一化 email 与 requestMeta", async () => {
    let seen: VerifiedIdentity | undefined;
    const spyLogin = createLogin<Cloudflare.Env>((e) => ({
      db: e.DB,
      kv: e.EMAIL_CODES,
      jwt: { secret: e.JWT_SECRET },
      email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
      socials: {
        github: {
          clientId: "cid",
          clientSecret: "cs",
          allowedRedirects: ["testapp://auth"],
        },
      },
      onVerified: (identity) => {
        seen = identity;
        return { userId: "u-gh" };
      },
    }));

    const startRes = await spyLogin.app.request(
      "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth",
      { method: "GET" },
      env
    );
    const state = new URL(startRes.headers.get("Location")!).searchParams.get("state")!;
    mockGithub(fetchSpy, { userId: 98765 });

    const cb = await spyLogin.app.request(
      `/auth/oauth/github/callback?code=gh-code&state=${state}`,
      {
        method: "GET",
        headers: { "User-Agent": "oauth-ua", "CF-Connecting-IP": "8.8.8.8" },
      },
      env
    );
    expect(cb.status).toBe(302);
    expect(seen).toEqual({
      email: "octo@example.com",
      provider: "github",
      providerUserId: "98765",
      // 白名单裁剪：two_factor_authentication / total_private_repos 等敏感字段不出库边界
      providerProfile: { id: 98765, login: "octocat", avatar_url: "https://a.png" },
      // 1.2.0 起：token 透传给 App 自行决定存不存（库不存不再分发）；
      // verified 邮箱给全量（归一化小写），App 可用整个列表对账降低账号分裂
      providerAccessToken: "gh-token",
      verifiedEmails: ["octo@example.com", "alt@example.com"],
      requestMeta: { ip: "8.8.8.8", userAgent: "oauth-ua" },
    });
  });
});

describe("插件未配置", () => {
  it("oauth 端点 → 404 not_configured", async () => {
    const bare = createLogin<Cloudflare.Env>((e) => ({
      db: e.DB,
      kv: e.EMAIL_CODES,
      jwt: { secret: e.JWT_SECRET },
      email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
      onVerified: () => ({ userId: "u-1" }),
    }));
    const res = await bare.app.request(
      "/auth/oauth/github/start?redirect=testapp%3A%2F%2Fauth",
      { method: "GET" },
      env
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_configured" });
  });
});
