// 从 Tono-Server test/helpers.ts 平移：initDb 只保留 auth 相关的 users + sessions
// （todos/notes/labels 为 Tono 业务表，与 auth 无关，不随库走）；
// app 由 createLogin 工厂构建（Tono 侧原为其完整应用）。
import { env } from "cloudflare:workers";
import { createLogin, createSession, signAccessToken } from "../src/index";

export const login = createLogin<Cloudflare.Env>((e) => ({
  db: e.DB,
  kv: e.EMAIL_CODES,
  jwt: { secret: e.JWT_SECRET },
  email: { resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM_ADDRESS },
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
