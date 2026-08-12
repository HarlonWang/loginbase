export const REFRESH_TOKEN_BYTES = 32;

export interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: number | null;
  created_at: number;
  last_used_at: number;
  user_agent: string | null;
  ip: string | null;
  revoked_at: number | null;
  replaced_by_id: string | null;
  rescued_at: number | null;
}

export interface CreateSessionInput {
  userId: string;
  userAgent?: string;
  ip?: string;
}

export interface CreateSessionOutput {
  sessionId: string;
  refreshToken: string;
  familyId: string;
}

export function generateRefreshToken(): string {
  const bytes = new Uint8Array(REFRESH_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function hashRefreshToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSession(
  db: D1Database,
  input: CreateSessionInput
): Promise<CreateSessionOutput> {
  const refreshToken = generateRefreshToken();
  const sessionId = await hashRefreshToken(refreshToken);
  const familyId = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, family_id, expires_at, created_at, last_used_at, user_agent, ip, revoked_at, replaced_by_id)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`
    )
    .bind(
      sessionId,
      input.userId,
      familyId,
      now,
      now,
      input.userAgent ?? null,
      input.ip ?? null
    )
    .run();
  return { sessionId, refreshToken, familyId };
}

export async function findSession(
  db: D1Database,
  sessionId: string
): Promise<SessionRow | null> {
  return await db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<SessionRow>();
}

export async function rotateSession(
  db: D1Database,
  oldSessionId: string,
  meta: { userAgent?: string; ip?: string }
): Promise<CreateSessionOutput | null> {
  const old = await findSession(db, oldSessionId);
  if (!old) return null;

  const refreshToken = generateRefreshToken();
  const newId = await hashRefreshToken(refreshToken);
  const now = Date.now();

  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, family_id, expires_at, created_at, last_used_at, user_agent, ip, revoked_at, replaced_by_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`
      )
      .bind(
        newId,
        old.user_id,
        old.family_id,
        now,
        now,
        meta.userAgent ?? old.user_agent,
        meta.ip ?? old.ip
      ),
    db
      .prepare(
        "UPDATE sessions SET revoked_at = ?, replaced_by_id = ? WHERE id = ? AND revoked_at IS NULL"
      )
      .bind(now, newId, oldSessionId),
  ]);

  return { sessionId: newId, refreshToken, familyId: old.family_id };
}

// 救活护栏：同一 family 在窗口内允许的最大救活次数。
// 正常的"丢回执诚实重试"每次最多触发 1 次救活（拿到新证后即不再用旧链）；
// 持续超限只可能是 token 被盗后多方交替使用，超限即按真重用撤销整链。
export const RESCUE_WINDOW_MS = 60 * 60 * 1000;
export const RESCUE_LIMIT = 3;

async function recentRescueCount(
  db: D1Database,
  familyId: string,
  since: number
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE family_id = ? AND rescued_at IS NOT NULL AND rescued_at > ?"
    )
    .bind(familyId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// tryRescueSession 的结果：
// - rescued       救活成功，session 为发给客户端的新证
// - not_eligible  无后继 / 后继已 revoked（链已前进）= 真重用，调用方应撤销整链
// - guardrail     后继仍 active 但同 family 救活已超护栏上限 = 疑似盗用交替，按真重用处理
export type RescueResult =
  | { status: "rescued"; session: CreateSessionOutput }
  | { status: "not_eligible" }
  | { status: "guardrail" };

// 丢回执诚实重试的救活：presented 的 token 已被轮换（revoked），但它的直接后继
// 仍 active（会话链未被第二方推进）—— 说明客户端没收到上次轮换的回执、手里只剩旧
// token。此时从后继再轮换一次、发一套可用的新证，避免误把整条链当成 token 重用杀掉。
export async function tryRescueSession(
  db: D1Database,
  revoked: SessionRow,
  meta: { userAgent?: string; ip?: string }
): Promise<RescueResult> {
  if (revoked.replaced_by_id === null) return { status: "not_eligible" };

  const successor = await findSession(db, revoked.replaced_by_id);
  if (!successor || successor.revoked_at !== null) return { status: "not_eligible" };

  const now = Date.now();
  if ((await recentRescueCount(db, revoked.family_id, now - RESCUE_WINDOW_MS)) >= RESCUE_LIMIT) {
    return { status: "guardrail" };
  }

  const refreshToken = generateRefreshToken();
  const newId = await hashRefreshToken(refreshToken);

  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, family_id, expires_at, created_at, last_used_at, user_agent, ip, revoked_at, replaced_by_id, rescued_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?)`
      )
      .bind(
        newId,
        successor.user_id,
        successor.family_id,
        now,
        now,
        meta.userAgent ?? successor.user_agent,
        meta.ip ?? successor.ip,
        now
      ),
    db
      .prepare(
        "UPDATE sessions SET revoked_at = ?, replaced_by_id = ? WHERE id = ? AND revoked_at IS NULL"
      )
      .bind(now, newId, successor.id),
  ]);

  return {
    status: "rescued",
    session: { sessionId: newId, refreshToken, familyId: successor.family_id },
  };
}

export async function revokeFamily(
  db: D1Database,
  familyId: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL"
    )
    .bind(Date.now(), familyId)
    .run();
}

export async function revokeSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
    )
    .bind(Date.now(), sessionId)
    .run();
}

export async function revokeAllForUser(
  db: D1Database,
  userId: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"
    )
    .bind(Date.now(), userId)
    .run();
}
