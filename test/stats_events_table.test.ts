// 存储契约：事件在 events 表里长什么样。业务语义（哪个事件、什么 outcome）由 stats.test.ts 覆盖。
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { flushEvents } from "@whlong/eventbase";
import { createLogin, storeCode } from "../src/index";
import type { LoginConfig } from "../src/index";
import { initDb, initEventsDb, wipeKv } from "./helpers";

interface Row {
  name: string;
  source: string;
  user_id: string | null;
  flow_id: string | null;
  platform: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  props: string | null;
}

function makeLogin(overrides: Partial<LoginConfig> = {}) {
  return createLogin<Cloudflare.Env>((e) => ({
    db: e.DB,
    kv: e.EMAIL_CODES,
    jwt: { secret: e.JWT_SECRET },
    email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
    onVerified: () => ({ userId: "u-events", isNewUser: true }),
    stats: { db: e.DB },
    ...overrides,
  }));
}

async function eventRows(): Promise<Row[]> {
  const { results } = await env.DB.prepare("SELECT * FROM events ORDER BY id").all<Row>();
  return results;
}

async function verify(app: ReturnType<typeof makeLogin>["app"], email: string) {
  await storeCode(env.EMAIL_CODES, email, "123456");
  return app.request(
    "/auth/code/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Version": "1.6.0", "X-Client-Platform": "android" },
      body: JSON.stringify({ email, code: "123456" }),
    },
    env
  );
}

beforeEach(async () => {
  await initDb();
  await initEventsDb();
  await wipeKv();
  await env.DB.prepare("DELETE FROM events").run();
});

describe("events 表里的存储形态", () => {
  it("落 events 表，source=server", async () => {
    const { app } = makeLogin();
    expect((await verify(app, "合表@example.com")).status).toBe(200);
    await flushEvents();

    const rows = await eventRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === "server")).toBe(true);
    expect(rows.map((r) => r.name)).toContain("login");

  });

  it("1.x 的独立列进 props，user_id / flow_id 仍是列", async () => {
    const { app } = makeLogin();
    await verify(app, "映射@example.com");
    await flushEvents();

    const login = (await eventRows()).find((r) => r.name === "login")!;
    expect(login.user_id).toBe("u-events");

    const props = JSON.parse(login.props!);
    expect(props.provider).toBe("email");
    expect(props.is_new_user).toBe(true);
    expect(props.client_version).toBe("1.6.0");
    expect(props.client_platform).toBe("android");
  });

  it("落 city / region——阶段 1 给 eventbase 加这两列就是为了它", async () => {
    const { app } = makeLogin();
    await storeCode(env.EMAIL_CODES, "地理@example.com", "123456");
    const req = new Request("http://localhost/auth/code/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "地理@example.com", code: "123456" }),
      cf: { country: "CL", asn: 22047, city: "Santiago", region: "Santiago Metropolitan" },
    } as RequestInit);
    expect((await app.request(req, undefined, env)).status).toBe(200);
    await flushEvents();

    const login = (await eventRows()).find((r) => r.name === "login")!;
    expect(login.country).toBe("CL");
    expect(login.city).toBe("Santiago");
    expect(login.region).toBe("Santiago Metropolitan");
  });

});
