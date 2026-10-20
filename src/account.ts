// 账号删除（3.1.0 起，配置 accountDeletion 后启用）。协议见 docs/protocol.md「账号删除」节。
// 两步：发删号码到账号邮箱 → 凭码删除。持 access token 只能证明「拿到了登录态」，
// 删号这种不可逆操作再要一次邮箱验证码，证明的是「能收账号邮箱的信」。
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  generateCode,
  storeCode,
  readCode,
  deleteCode,
  incrementAttempts,
  MAX_ATTEMPTS,
} from "./code.js";
import { sendCodeEmail, resolveEmailLocale, warnEmailConfigOnce } from "./email.js";
import { checkSendRateLimit, recordSend } from "./rate_limit.js";
import { deleteAllForUser } from "./session.js";
import { logEvent } from "./log.js";
import { createTracker, clientOf, clientRequestMeta } from "./stats.js";
import { trimmedField } from "./body.js";
import { matchDemoAccount } from "./demo_account.js";
import type { AuthVariables } from "./middleware.js";
import type { AccountDeletionConfig, LoginConfig } from "./config.js";

const REASON_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

type Ctx = Context<{ Variables: AuthVariables }>;

export function registerAccountDeletion<TEnv>(
  auth: Hono<{ Variables: AuthVariables }>,
  getConfig: (env: TEnv) => LoginConfig,
  authMiddleware: MiddlewareHandler<{ Variables: AuthVariables }>
): void {
  const cfg = (c: { env: unknown }) => getConfig(c.env as TEnv);
  const track = createTracker(getConfig);

  /**
   * 两个端点共用的前半段：配置 → 账号邮箱 → App 前置检查。
   * 返回 Response 表示已拒绝，否则返回删号所需的上下文。
   */
  async function prepare(
    c: Ctx,
    endpoint: "code" | "delete"
  ): Promise<Response | { deletion: AccountDeletionConfig; email: string }> {
    const deletion = cfg(c).accountDeletion;
    if (!deletion) return c.json({ error: "not_configured" }, 404);
    const userId = c.get("userId");
    const event = endpoint === "code" ? "account_delete_code" : "account_delete";

    let email: string | null;
    let check: Awaited<ReturnType<NonNullable<AccountDeletionConfig["check"]>>>;
    try {
      email = await deletion.emailOf(userId);
      check = email ? ((await deletion.check?.(userId)) ?? { ok: true }) : { ok: true };
    } catch {
      track(c, { event, outcome: "internal", userId });
      return c.json({ error: "internal" }, 500);
    }
    if (!email) {
      track(c, { event, outcome: "account_not_found", userId });
      return c.json({ error: "account_not_found" }, 404);
    }
    if (!check.ok) {
      const reason = REASON_PATTERN.test(check.reason) ? check.reason : "blocked";
      track(c, { event, outcome: "blocked", userId, meta: { reason } });
      return c.json({ error: "deletion_blocked", reason }, 409);
    }
    return { deletion, email: email.trim().toLowerCase() };
  }

  auth.post("/account/delete/code", authMiddleware, async (c) => {
    const prepared = await prepare(c, "code");
    if (prepared instanceof Response) return prepared;
    const { email } = prepared;
    const userId = c.get("userId");
    const body = await c.req
      .json<{ locale?: unknown }>()
      .catch(() => ({} as { locale?: unknown }));

    // 与登录发码共用同一套限流：删号码同样是往这个邮箱发信
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const rl = await checkSendRateLimit(cfg(c).kv, email, ip);
    if (!rl.allowed) {
      track(c, {
        event: "rate_limited",
        outcome: rl.layer,
        userId,
        meta: { endpoint: "account_delete_code" },
      });
      return c.json(
        { error: "too_many_requests", retryAfterSeconds: rl.retryAfterSeconds },
        429
      );
    }

    // 演示账号同样走固定码、不发信，否则审核员测不了删号（App 可在 check 里另行拒绝）
    const demo = matchDemoAccount(cfg(c), email);
    const code = demo?.code ?? generateCode();
    warnEmailConfigOnce(cfg(c).email, cfg(c).onEvent ?? logEvent);
    const locale = resolveEmailLocale(cfg(c).email, body.locale);
    if (demo === null) {
      try {
        await sendCodeEmail(cfg(c).email, email, code, locale.locale, "delete_account");
      } catch (err) {
        track(c, {
          event: "code_send_failed",
          userId,
          meta: { purpose: "delete_account", message: String(err) },
        });
        return c.json({ error: "internal" }, 500);
      }
    }

    await storeCode(cfg(c).kv, email, code, "delete_account");
    await recordSend(cfg(c).kv, email, ip);
    track(c, {
      event: "account_delete_code",
      outcome: "ok",
      userId,
      meta: { ...(demo ? { demo: true } : {}), locale: locale.locale },
    });
    return c.json({ cooldownSeconds: 60 }, 200);
  });

  auth.post("/account/delete", authMiddleware, async (c) => {
    const prepared = await prepare(c, "delete");
    if (prepared instanceof Response) return prepared;
    const { deletion, email } = prepared;
    const userId = c.get("userId");
    const body = await c.req
      .json<{ code?: string }>()
      .catch(() => ({} as { code?: string }));
    const code = trimmedField(body.code);
    const kv = cfg(c).kv;

    const stored = await readCode(kv, email, "delete_account");
    if (!stored) {
      track(c, { event: "account_delete", outcome: "code_not_found", userId });
      return c.json({ error: "code_expired" }, 400);
    }
    if (stored.code !== code) {
      const attempts = await incrementAttempts(kv, email, stored, "delete_account");
      if (attempts >= MAX_ATTEMPTS) {
        await deleteCode(kv, email, "delete_account");
        track(c, { event: "account_delete", outcome: "too_many_attempts", userId });
        return c.json({ error: "too_many_attempts" }, 429);
      }
      track(c, { event: "account_delete", outcome: "invalid_code", userId });
      return c.json({ error: "invalid_code" }, 400);
    }
    await deleteCode(kv, email, "delete_account");

    try {
      await deletion.onDelete({
        userId,
        email,
        requestMeta: {
          ip: c.req.header("CF-Connecting-IP") ?? undefined,
          userAgent: c.req.header("User-Agent") ?? undefined,
          ...clientRequestMeta(clientOf(c)),
        },
      });
    } catch {
      track(c, { event: "account_delete", outcome: "internal", userId });
      return c.json({ error: "internal" }, 500);
    }

    await deleteAllForUser(cfg(c).db, userId);
    track(c, { event: "account_delete", outcome: "ok", userId });
    return c.body(null, 204);
  });
}
