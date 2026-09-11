// 登录统计事件落库（方案见 docs/stats-design.md「v1 实现方案」）。
// 事件写 eventbase 的 events 表，与客户端埋点合表——漏斗的服务端段与客户端段
// 因此可以串起来。
//
// 第一原则：**统计绝不能成为登录的故障源**。消费方未必已对埋点库执行迁移，
// 所以写入失败是预期内的常态：一律吞掉、异步写、首次失败告警一次。
import { createTracker as createEventsTracker } from "@whlong/eventbase";
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

// 按 config 对象记忆化（同 email.ts 的 warnEmailConfigOnce）：生产上 config 由
// memoizeResolver 按 env 缓存，等价于每个 Worker 一次告警。
const warnedConfigs = new WeakSet<LoginConfig>();

export interface TrackContext {
  env: unknown;
  req: { raw: Request };
  /** Hono 在无 ExecutionContext 时访问此属性会抛，故所有读取都包在 try 内 */
  executionCtx?: ExecutionContext;
}

function defer(c: TrackContext, p: Promise<unknown>): void {
  try {
    c.executionCtx?.waitUntil(p);
  } catch {
    // 无 ExecutionContext（如 app.request() 直调）：写入照常进行，只是不被延长生命周期
  }
}

/**
 * StatEvent → eventbase ServerEvent。1.x 落在 `auth_events` 独立列的字段在 events 表没有对应列，
 * 一律进 props：列名键沿用 snake_case，`meta` 的键原样并入（既有契约，改名会断掉
 * 已写好的查询与历史数据的可比性）。geo 由 eventbase 自己从 request 取，不在此传。
 */
function toServerEvent(e: StatEvent, client: ClientId) {
  return {
    name: e.event,
    ...(e.userId !== undefined ? { userId: e.userId } : {}),
    ...(e.flowId !== undefined ? { flowId: e.flowId } : {}),
    props: {
      ...(e.outcome !== undefined ? { outcome: e.outcome } : {}),
      ...(e.provider !== undefined ? { provider: e.provider } : {}),
      ...(e.isNewUser !== undefined ? { is_new_user: e.isNewUser } : {}),
      ...(client.version ? { client_version: client.version } : {}),
      ...(client.platform ? { client_platform: client.platform } : {}),
      ...e.meta,
    },
  };
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

    const stats = cfg.stats;
    if (!stats || stats.enabled === false) return;

    createEventsTracker(stats.db, {
      onError: (err: unknown) => warnUnavailableOnce(cfg, onEvent, err),
    })({ request: c.req.raw, waitUntil: (p) => defer(c, p) }, toServerEvent(e, client));
  };
}

/** 最可能的原因是没对埋点库执行迁移。只告警一次，避免每请求刷屏。 */
function warnUnavailableOnce(
  cfg: LoginConfig,
  onEvent: (event: Record<string, unknown>) => void,
  err: unknown
): void {
  if (warnedConfigs.has(cfg)) return;
  warnedConfigs.add(cfg);
  onEvent({
    event: "stats_unavailable",
    hint: "埋点库写入失败，请对 stats.db 指向的库执行 eventbase 的 migrations；登录不受影响",
    message: String(err),
  });
}
