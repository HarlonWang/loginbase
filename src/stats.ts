// 登录统计事件落库（方案见 docs/stats-design.md「v1 实现方案」）。
//
// 第一原则：**统计绝不能成为登录的故障源**。模块默认开启，而消费方升级包后
// 未必已执行 migration 0002，所以写入失败是预期内的常态：一律吞掉、异步写、
// 首次失败告警一次。登录成功与否与本模块无关。
import type { LoginConfig } from "./config.js";
import { logEvent } from "./log.js";

export interface StatEvent {
  event: string;
  outcome?: string;
  provider?: "email" | "github";
  userId?: string;
  /** 串联 OAuth 三段的标识；绝不可用 state / otc 充当（单次凭证不进长期表） */
  flowId?: string;
  isNewUser?: boolean;
  /** 落 meta 列（JSON），并摊平进 onEvent */
  meta?: Record<string, unknown>;
  /** 只摊平进 onEvent，**不落表**（ip 等 v1 判定不入库的字段走这里） */
  hookOnly?: Record<string, unknown>;
}

/** 供测试等待异步写入完成；生产路径走 waitUntil，不依赖它 */
const pending = new Set<Promise<unknown>>();

export async function flushStats(): Promise<void> {
  await Promise.allSettled([...pending]);
}

// 按 config 对象记忆化（同 email.ts 的 warnEmailConfigOnce）：生产上 config 由
// memoizeResolver 按 env 缓存，等价于每个 Worker 一次告警。
const warnedConfigs = new WeakSet<LoginConfig>();

export interface TrackContext {
  env: unknown;
  req: { raw: Request };
  /** Hono 在无 ExecutionContext 时访问此属性会抛，故所有读取都包在 try 内 */
  executionCtx?: ExecutionContext;
}

function countryOf(c: TrackContext): string {
  try {
    const country = (c.req.raw as { cf?: { country?: string } }).cf?.country;
    return country ?? "unknown";
  } catch {
    return "unknown";
  }
}

function defer(c: TrackContext, p: Promise<unknown>): void {
  const tracked = p.finally(() => pending.delete(tracked));
  pending.add(tracked);
  try {
    c.executionCtx?.waitUntil(tracked);
  } catch {
    // 无 ExecutionContext（如 app.request() 直调）：写入照常进行，只是不被延长生命周期
  }
}

async function writeEvent(
  db: D1Database,
  e: StatEvent,
  country: string,
  now: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_events
         (at, event, outcome, provider, user_id, flow_id, is_new_user, country, source, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'server', ?)`
    )
    .bind(
      now,
      e.event,
      e.outcome ?? null,
      e.provider ?? null,
      e.userId ?? null,
      e.flowId ?? null,
      e.isNewUser === undefined ? null : e.isNewUser ? 1 : 0,
      country,
      e.meta ? JSON.stringify(e.meta) : null
    )
    .run();
}

/**
 * 事件出口：先照原样喂 onEvent（消费方钩子，形态与 1.3.0 保持一致），
 * 再异步写自己的表。两条路径并行——onEvent 是给消费方的，不被库劫持去写库表。
 */
export function createTracker<TEnv>(getConfig: (env: TEnv) => LoginConfig) {
  return (c: TrackContext, e: StatEvent): void => {
    const cfg = getConfig(c.env as TEnv);
    const onEvent = cfg.onEvent ?? logEvent;

    onEvent({
      event: e.event,
      ...(e.outcome !== undefined ? { outcome: e.outcome } : {}),
      ...(e.provider !== undefined ? { provider: e.provider } : {}),
      ...(e.userId !== undefined ? { userId: e.userId } : {}),
      ...(e.flowId !== undefined ? { flowId: e.flowId } : {}),
      ...(e.isNewUser !== undefined ? { isNewUser: e.isNewUser } : {}),
      ...e.meta,
      ...e.hookOnly,
    });

    if (cfg.stats?.enabled === false) return;

    defer(
      c,
      writeEvent(cfg.db, e, countryOf(c), Date.now()).catch((err: unknown) => {
        // 最可能的原因是没执行 migration 0002。只告警一次，避免每请求刷屏。
        if (warnedConfigs.has(cfg)) return;
        warnedConfigs.add(cfg);
        onEvent({
          event: "stats_unavailable",
          hint: "auth_events 写入失败，请执行 migration 0002；登录不受影响",
          message: String(err),
        });
      })
    );
  };
}
