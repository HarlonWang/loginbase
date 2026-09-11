// 测试夹具：onVerified 复刻 Tono 语义（users upsert + 90 天试用 + user 载荷），
// 使平移自 Tono 的 HTTP 测试在钩子化后原样通过——夹具即钩子化等价性的对照组。
import { env } from "cloudflare:workers";
import ebEvents from "../node_modules/@whlong/eventbase/migrations/0001_events.sql?raw";
import ebEventId from "../node_modules/@whlong/eventbase/migrations/0004_event_id.sql?raw";
import ebDeviceId from "../node_modules/@whlong/eventbase/migrations/0005_device_id.sql?raw";
import ebCity from "../node_modules/@whlong/eventbase/migrations/0006_geo_city.sql?raw";
import ebRegion from "../node_modules/@whlong/eventbase/migrations/0007_geo_region.sql?raw";

const EVENTBASE_SCHEMA = [ebEvents, ebEventId, ebDeviceId, ebCity, ebRegion];
import { createLogin, createSession, signAccessToken } from "../src/index";
import type { VerifiedResult } from "../src/index";

const TRIAL_PERIOD_MS = 90 * 24 * 60 * 60 * 1000;

export async function tonoLikeOnVerified(email: string): Promise<VerifiedResult> {
  const now = Date.now();
  let user = await env.DB.prepare(
    "SELECT id, email, pro_expires_at, created_at FROM users WHERE email = ?"
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      pro_expires_at: number | null;
      created_at: number;
    }>();

  let isNewUser = false;
  if (!user) {
    const id = crypto.randomUUID();
    const proExpiresAt = now + TRIAL_PERIOD_MS;
    await env.DB.prepare(
      "INSERT INTO users (id, email, pro_expires_at, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(id, email, proExpiresAt, now)
      .run();
    user = { id, email, pro_expires_at: proExpiresAt, created_at: now };
    isNewUser = true;
  }

  return {
    userId: user.id,
    isNewUser,
    user: {
      id: user.id,
      email: user.email,
      isPro: user.pro_expires_at != null && user.pro_expires_at > now,
      proExpiresAt: user.pro_expires_at,
      createdAt: user.created_at,
    },
  };
}

export const login = createLogin<Cloudflare.Env>((e) => ({
  db: e.DB,
  kv: e.EMAIL_CODES,
  jwt: { secret: e.JWT_SECRET },
  email: {
    resendApiKey: e.RESEND_API_KEY,
    from: e.EMAIL_FROM_ADDRESS,
    brand: "Tono",
  },
  socials: {
    github: {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      allowedRedirects: ["testapp://auth"],
    },
  },
  onVerified: ({ email }) => tonoLikeOnVerified(email),
}));

const app = login.app;

export async function initDb() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pro_expires_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, family_id TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, user_agent TEXT, ip TEXT, revoked_at INTEGER, replaced_by_id TEXT, rescued_at INTEGER);
  `;
  for (const stmt of schema.split(";").filter((s) => s.trim())) {
    await env.DB.prepare(stmt).run();
  }
}

/** eventbase 的 events 表（stats.db 路径用）。DDL 直接取自装好的包，与生产同源。 */
export async function initEventsDb() {
  for (const stmt of EVENTBASE_SCHEMA.join(";").split(";").filter((s) => s.trim())) {
    await env.DB.prepare(stmt)
      .run()
      .catch((e: Error) => {
        if (!/duplicate column name/.test(e.message)) throw e;
      });
  }
}

export async function wipeKv() {
  const list = await env.EMAIL_CODES.list();
  for (const key of list.keys) await env.EMAIL_CODES.delete(key.name);
}

export interface TestUser {
  userId: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: { id: string; email: string; proExpiresAt: number };
}

export async function createTestUser(
  email = "test@example.com",
  opts: { isPro?: boolean } = {}
): Promise<TestUser> {
  const now = Date.now();
  const proExpiresAt =
    opts.isPro === false ? now - 1000 : now + 30 * 24 * 60 * 60 * 1000;

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();

  let userId: string;
  if (existing) {
    userId = existing.id;
  } else {
    userId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, email, pro_expires_at, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(userId, email, proExpiresAt, now)
      .run();
  }

  const { sessionId, refreshToken } = await createSession(env.DB, { userId });
  const accessToken = await signAccessToken(env.JWT_SECRET, userId, sessionId);
  return {
    userId,
    accessToken,
    refreshToken,
    sessionId,
    user: { id: userId, email, proExpiresAt },
  };
}

export async function authHeader(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export { env, app };
