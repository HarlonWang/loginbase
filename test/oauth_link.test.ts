// link 流程测试（1.2.0 新增）：已登录用户绑定第二身份。
// 与 login 的关键差别——Bearer 鉴权发起、callback 按 state.mode 分流、
// 不建会话不发 token、email 可缺省、冲突走返回值。协议见 docs/protocol.md。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createLogin, createSession, signAccessToken } from "../src/index";
import type { LinkedIdentity, LinkResult } from "../src/index";
import { initDb, wipeKv } from "./helpers";

const REDIRECT = "testapp://auth/link";

function mockGithub(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  opts: {
    userId?: number;
    emails?: Array<{ email: string; primary: boolean; verified: boolean }>;
  } = {}
) {
  const { userId = 4242, emails } = opts;
  fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gh-link-token" }), {
        status: 200,
      });
    }
    if (url.startsWith("https://api.github.com/user/emails")) {
      return new Response(
        JSON.stringify(
          emails ?? [{ email: "Linked@Example.com", primary: true, verified: true }]
        ),
        { status: 200 }
      );
    }
    if (url.startsWith("https://api.github.com/applications/") && url.endsWith("/token")) {
      return new Response(JSON.stringify({ user: { id: userId, login: "linkcat" } }), {
        status: 200,
      });
    }
    if (url === `https://api.github.com/user/${userId}`) {
      return new Response(JSON.stringify({ id: userId, login: "linkcat" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") throw new Error("GET /user must not be called");
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** 建一个带 onLinked 的 login 实例；onLinked 行为由入参决定 */
function makeLogin(onLinked: (i: LinkedIdentity) => LinkResult) {
  return createLogin<Cloudflare.Env>((e) => ({
    db: e.DB,
    kv: e.EMAIL_CODES,
    jwt: { secret: e.JWT_SECRET },
    email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
    socials: {
      github: {
        clientId: "cid",
        clientSecret: "cs",
        allowedRedirects: [REDIRECT],
      },
    },
    onVerified: () => ({ userId: "u-login" }),
    onLinked,
  }));
}

async function tokenFor(userId: string): Promise<string> {
  const { sessionId } = await createSession(env.DB, { userId });
  return signAccessToken(env.JWT_SECRET, userId, sessionId);
}

async function linkStart(
  login: ReturnType<typeof makeLogin>,
  token: string | null,
  redirect: string = REDIRECT
) {
  return login.app.request(
    "/auth/oauth/github/link/start",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ redirect }),
    },
    env
  );
}

function stateOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get("state")!;
}

describe("POST /auth/oauth/github/link/start", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
  });

  it("Bearer + 白名单 redirect → 200 authorizeUrl，state 载荷带 mode/userId", async () => {
    const login = makeLogin(() => ({ ok: true }));
    const token = await tokenFor("u-42");
    const res = await linkStart(login, token);

    expect(res.status).toBe(200);
    const { authorizeUrl } = await res.json<{ authorizeUrl: string }>();
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");

    const raw = await env.EMAIL_CODES.get(`oauth:state:${stateOf(authorizeUrl)}`);
    expect(JSON.parse(raw!)).toEqual({
      redirect: REDIRECT,
      mode: "link",
      userId: "u-42",
      // 1.4.0 起随载荷带上统计用的流程标识（见 docs/stats-design.md）
      flowId: expect.any(String),
    });
  });

  it("无 token / 坏 token → 401（link 是鉴权端点，login 的 start 不是）", async () => {
    const login = makeLogin(() => ({ ok: true }));
    expect((await linkStart(login, null)).status).toBe(401);
    expect((await linkStart(login, "not-a-jwt")).status).toBe(401);
  });

  it("redirect 不在白名单 → 400 invalid_redirect", async () => {
    const login = makeLogin(() => ({ ok: true }));
    const token = await tokenFor("u-42");
    const res = await linkStart(login, token, "evil://phish");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_redirect" });
  });

  it("未提供 onLinked → 404 not_configured（默认关闭、显式启用）", async () => {
    const noLink = createLogin<Cloudflare.Env>((e) => ({
      db: e.DB,
      kv: e.EMAIL_CODES,
      jwt: { secret: e.JWT_SECRET },
      email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
      socials: {
        github: { clientId: "cid", clientSecret: "cs", allowedRedirects: [REDIRECT] },
      },
      onVerified: () => ({ userId: "u-login" }),
    }));
    const token = await tokenFor("u-42");
    const res = await noLink.app.request(
      "/auth/oauth/github/link/start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ redirect: REDIRECT }),
      },
      env
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_configured" });
  });
});

describe("GET /auth/oauth/github/callback（link 分支）", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await initDb();
    await wipeKv();
    await env.DB.prepare("DELETE FROM sessions").run();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  async function runLink(
    onLinked: (i: LinkedIdentity) => LinkResult,
    mockOpts: Parameters<typeof mockGithub>[1] = {}
  ) {
    const login = makeLogin(onLinked);
    const token = await tokenFor("u-42");
    const startRes = await linkStart(login, token);
    const { authorizeUrl } = await startRes.json<{ authorizeUrl: string }>();
    mockGithub(fetchSpy, mockOpts);
    // callback 刻意不带 Authorization：身份只来自 state 载荷，
    // 故用户在 GitHub 授权页停留到 access token 过期也不影响 link 成功
    const res = await login.app.request(
      `/auth/oauth/github/callback?code=gh-code&state=${stateOf(authorizeUrl)}`,
      { method: "GET", headers: { "User-Agent": "link-ua", "CF-Connecting-IP": "1.1.1.1" } },
      env
    );
    return { res, location: new URL(res.headers.get("Location")!) };
  }

  it("成功 → 302 redirect?linked=github，onLinked 收到 userId 与身份，且不建会话", async () => {
    let seen: LinkedIdentity | undefined;
    const { res, location } = await runLink((i) => {
      seen = i;
      return { ok: true };
    });

    expect(res.status).toBe(302);
    expect(location.searchParams.get("linked")).toBe("github");
    expect(location.searchParams.get("otc")).toBeNull(); // 不发 token，无 otc 中转
    expect(seen).toEqual({
      userId: "u-42", // 来自 state，不是客户端传入
      provider: "github",
      providerUserId: "4242",
      email: "linked@example.com", // 归一化
      verifiedEmails: ["linked@example.com"],
      providerProfile: { id: 4242, login: "linkcat" },
      providerAccessToken: "gh-link-token",
      requestMeta: { ip: "1.1.1.1", userAgent: "link-ua" },
    });

    // link 不创建会话：库里只应有 tokenFor 建的那一条
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?"
    )
      .bind("u-42")
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it("冲突 → 302 redirect?error=<reason>（库不裁决，App 说了算）", async () => {
    const { location } = await runLink(() => ({ ok: false, reason: "already_linked" }));
    expect(location.searchParams.get("error")).toBe("already_linked");
    expect(location.searchParams.get("linked")).toBeNull();
  });

  it("畸形 reason → 回落 internal（回跳 URL 卫生）", async () => {
    const { location } = await runLink(() => ({
      ok: false,
      reason: "boom: user bob@example.com 已绑定",
    }));
    expect(location.searchParams.get("error")).toBe("internal");
  });

  it("onLinked 抛错 → 302 redirect?error=internal", async () => {
    const { location } = await runLink(() => {
      throw new Error("db down");
    });
    expect(location.searchParams.get("error")).toBe("internal");
  });

  it("GitHub 无 verified 邮箱仍成功 —— userId 已定，email 只是附加信息", async () => {
    let seen: LinkedIdentity | undefined;
    const { location } = await runLink(
      (i) => {
        seen = i;
        return { ok: true };
      },
      { emails: [{ email: "private@x.com", primary: true, verified: false }] }
    );
    expect(location.searchParams.get("linked")).toBe("github");
    expect(seen?.email).toBeUndefined();
    expect(seen?.verifiedEmails).toEqual([]);
  });

  it("state 单次使用：同一 state 二次 callback → 400 invalid_state", async () => {
    const login = makeLogin(() => ({ ok: true }));
    const token = await tokenFor("u-42");
    const { authorizeUrl } = await (await linkStart(login, token)).json<{
      authorizeUrl: string;
    }>();
    mockGithub(fetchSpy);
    const state = stateOf(authorizeUrl);
    const first = await login.app.request(
      `/auth/oauth/github/callback?code=c1&state=${state}`,
      { method: "GET" },
      env
    );
    expect(first.status).toBe(302);
    const second = await login.app.request(
      `/auth/oauth/github/callback?code=c1&state=${state}`,
      { method: "GET" },
      env
    );
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "invalid_state" });
  });

  it("升级期在飞的旧 state（无 mode）→ 仍走 login 分支，1.1.0 行为不变", async () => {
    // 部署 1.2.0 的瞬间，KV 里可能还躺着 1.1.0 写入的 state（TTL 600s）。
    // 新代码按 mode 分流，缺省即 login——手工写一条旧形态 state 锁住这个兼容性。
    const login = makeLogin(() => ({ ok: true }));
    const state = "legacy-state-token";
    await env.EMAIL_CODES.put(
      `oauth:state:${state}`,
      JSON.stringify({ redirect: REDIRECT }), // 1.1.0 的 StateRecord 只有 redirect
      { expirationTtl: 600 }
    );
    mockGithub(fetchSpy);

    const res = await login.app.request(
      `/auth/oauth/github/callback?code=c&state=${state}`,
      { method: "GET" },
      env
    );
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("otc")).not.toBeNull(); // 走 login：发 otc
    expect(loc.searchParams.get("linked")).toBeNull();
  });
});

describe("scope 可配（1.2.0）", () => {
  beforeEach(async () => {
    await initDb();
    await wipeKv();
  });

  it("缺省 → user:email；配置后 login 与 link 两条流程都用配置值", async () => {
    const scoped = createLogin<Cloudflare.Env>((e) => ({
      db: e.DB,
      kv: e.EMAIL_CODES,
      jwt: { secret: e.JWT_SECRET },
      email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
      socials: {
        github: {
          clientId: "cid",
          clientSecret: "cs",
          allowedRedirects: [REDIRECT],
          scope: "user:email public_repo",
        },
      },
      onVerified: () => ({ userId: "u-1" }),
      onLinked: () => ({ ok: true }),
    }));

    const loginStart = await scoped.app.request(
      `/auth/oauth/github/start?redirect=${encodeURIComponent(REDIRECT)}`,
      { method: "GET" },
      env
    );
    expect(
      new URL(loginStart.headers.get("Location")!).searchParams.get("scope")
    ).toBe("user:email public_repo");

    const token = await tokenFor("u-42");
    const linkRes = await linkStart(scoped, token);
    const { authorizeUrl } = await linkRes.json<{ authorizeUrl: string }>();
    expect(new URL(authorizeUrl).searchParams.get("scope")).toBe(
      "user:email public_repo"
    );
  });
});
