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
  /** 显式来源；缺省读当前请求头。浏览器发出的 OAuth 请求没有 App 的头，callback 从 state 里给 */
  client?: ClientId;
}

/** 统计切片轴（docs/protocol.md「客户端标识」节）；只收结构化上报，永不从 UA 解析（CLAUDE.md 铁律） */
export interface ClientId {
  version: string | null;
  platform: string | null;
}

export const CLIENT_ID_ABSENT: ClientId = { version: null, platform: null };

// 白名单校验、非法静默丢弃——与 OAuth start 的自述参数同一条纪律：统计绝不能成为登录的故障源
const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;
const CLIENT_PLATFORMS = new Set(["android", "ios", "web", "desktop"]);

export function clientVersionOf(raw: string | null | undefined): string | null {
  return raw && CLIENT_VERSION_PATTERN.test(raw) ? raw : null;
}

/** 平台值区分大小写（只认小写），避免同一平台在切片里裂成两桶 */
export function clientPlatformOf(raw: string | null | undefined): string | null {
  return raw && CLIENT_PLATFORMS.has(raw) ? raw : null;
}

export function clientOf(c: { req: { raw: Request } }): ClientId {
  const headers = c.req.raw.headers;
  return {
    version: clientVersionOf(headers.get("X-Client-Version")),
    platform: clientPlatformOf(headers.get("X-Client-Platform")),
  };
}

export function clientRequestMeta(client: ClientId): {
  clientVersion?: string;
  clientPlatform?: string;
} {
  return {
    ...(client.version ? { clientVersion: client.version } : {}),
    ...(client.platform ? { clientPlatform: client.platform } : {}),
  };
}

/** 供测试等待异步写入完成；生产路径走 waitUntil，不依赖它 */
const pending = new Set<Promise<unknown>>();

export async function flushStats(): Promise<void> {
  await Promise.allSettled([...pending]);
}

// 按 config 对象记忆化（同 email.ts 的 warnEmailConfigOnce）：生产上 config 由
// memoizeResolver 按 env 缓存，等价于每个 Worker 一次告警。
const warnedConfigs = new WeakSet<LoginConfig>();
// 消费方升了包但没跑 migration 0003：回退到不带客户端两列的 INSERT，事件不丢
const legacySchemaConfigs = new WeakSet<LoginConfig>();

export interface TrackContext {
  env: unknown;
  req: { raw: Request };
  /** Hono 在无 ExecutionContext 时访问此属性会抛，故所有读取都包在 try 内 */
  executionCtx?: ExecutionContext;
}

interface Geo {
  country: string;
  asn: number | null;
  colo: string | null;
  timezone: string | null;
  city: string | null;
  region: string | null;
}

const GEO_ABSENT: Geo = {
  country: "unknown",
  asn: null,
  colo: null,
  timezone: null,
  city: null,
  region: null,
};

/**
 * 全部取自 Cloudflare 边缘的 `request.cf`——它在请求到达 Worker 前就已填好，
 * 零外部依赖、无额外请求。本地 wrangler dev 与测试环境没有 cf，故整体兜底。
 * 注意这是 **IP 归属地**，不是用户声明的位置：代理会显示出口所在地。
 */
function geoOf(c: TrackContext): Geo {
  try {
    const cf = (c.req.raw as { cf?: Partial<Record<keyof Geo, unknown>> }).cf;
    if (!cf) return GEO_ABSENT;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      country: str(cf.country) ?? "unknown",
      asn: typeof cf.asn === "number" ? cf.asn : null,
      colo: str(cf.colo),
      timezone: str(cf.timezone),
      city: str(cf.city),
      region: str(cf.region),
    };
  } catch {
    return GEO_ABSENT;
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
  geo: Geo,
  client: ClientId,
  now: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_events
         (at, event, outcome, provider, user_id, flow_id, is_new_user,
          country, asn, colo, timezone, city, region, source, meta,
          client_version, client_platform)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', ?, ?, ?)`
    )
    .bind(...bindings(e, geo, now), client.version, client.platform)
    .run();
}

async function writeEventLegacy(
  db: D1Database,
  e: StatEvent,
  geo: Geo,
  now: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_events
         (at, event, outcome, provider, user_id, flow_id, is_new_user,
          country, asn, colo, timezone, city, region, source, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', ?)`
    )
    .bind(...bindings(e, geo, now))
    .run();
}

function bindings(e: StatEvent, geo: Geo, now: number): unknown[] {
  return [
    now,
    e.event,
    e.outcome ?? null,
    e.provider ?? null,
    e.userId ?? null,
    e.flowId ?? null,
    e.isNewUser === undefined ? null : e.isNewUser ? 1 : 0,
    geo.country,
    geo.asn,
    geo.colo,
    geo.timezone,
    geo.city,
    geo.region,
    e.meta ? JSON.stringify(e.meta) : null,
  ];
}

function isMissingClientColumn(err: unknown): boolean {
  return /no such column|has no column named/i.test(String(err)) && /client_/.test(String(err));
}

/**
 * 事件出口：先照原样喂 onEvent（消费方钩子，形态与 1.3.0 保持一致），
 * 再异步写自己的表。两条路径并行——onEvent 是给消费方的，不被库劫持去写库表。
 */
export function createTracker<TEnv>(getConfig: (env: TEnv) => LoginConfig) {
  return (c: TrackContext, e: StatEvent): void => {
    const cfg = getConfig(c.env as TEnv);
    const onEvent = cfg.onEvent ?? logEvent;

    const client = e.client ?? clientOf(c);
    onEvent({
      event: e.event,
      ...(e.outcome !== undefined ? { outcome: e.outcome } : {}),
      ...(e.provider !== undefined ? { provider: e.provider } : {}),
      ...(e.userId !== undefined ? { userId: e.userId } : {}),
      ...(e.flowId !== undefined ? { flowId: e.flowId } : {}),
      ...(e.isNewUser !== undefined ? { isNewUser: e.isNewUser } : {}),
      ...clientRequestMeta(client),
      ...e.meta,
      ...e.hookOnly,
    });

    if (cfg.stats?.enabled === false) return;

    const now = Date.now();
    const geo = geoOf(c);
    const write = legacySchemaConfigs.has(cfg)
      ? writeEventLegacy(cfg.db, e, geo, now)
      : writeEvent(cfg.db, e, geo, client, now).catch(async (err: unknown) => {
          if (!isMissingClientColumn(err)) throw err;
          // 同一请求的多条事件并发写入会一起撞上，去重靠集合而非首个失败者
          if (!legacySchemaConfigs.has(cfg)) {
            legacySchemaConfigs.add(cfg);
            onEvent({
              event: "stats_schema_outdated",
              hint: "auth_events 缺 client_version / client_platform 列，请执行 migration 0003；事件已按旧表形态落库",
              message: String(err),
            });
          }
          await writeEventLegacy(cfg.db, e, geo, now);
        });
    defer(c, write.catch((err: unknown) => warnUnavailableOnce(cfg, onEvent, err)));
  };
}

/** 最可能的原因是没执行 migration 0002。只告警一次，避免每请求刷屏。 */
function warnUnavailableOnce(
  cfg: LoginConfig,
  onEvent: (event: Record<string, unknown>) => void,
  err: unknown
): void {
  if (warnedConfigs.has(cfg)) return;
  warnedConfigs.add(cfg);
  onEvent({
    event: "stats_unavailable",
    hint: "auth_events 写入失败，请执行 migration 0002；登录不受影响",
    message: String(err),
  });
}
