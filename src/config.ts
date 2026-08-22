import type { EmailConfig } from "./email.js";

// onVerified：库与 App 的唯一用户语义边界。身份确认成功后调用；
// 返回的 isNewUser / user 原样透传进 verify / oauth exchange 响应。
// 抛错 → 500 internal（验证码已焚；会话在钩子成功后才创建，不留孤儿 session）。
export interface VerifiedIdentity {
  email: string;
  provider: "email" | "github";
  providerUserId?: string;
  /**
   * OAuth provider 的公开档案（GitHub = /user 响应裁剪到建档白名单：
   * id/login/name/email/avatar_url/bio/html_url/company/location/blog/
   * twitter_username/created_at），供 App 建档取资料；email provider 恒缺省。
   * 认证视图的敏感字段（私有统计、2FA 状态等）在库边界内剔除。
   */
  providerProfile?: unknown;
  /**
   * OAuth provider 的 access token（1.2.0 起）。库**只透传、不存储、不再分发**——
   * 第三方 API 凭据是各 App 的产品决策，不属登录底座（见 docs/design.md 定位边界）。
   * GitHub OAuth App 的 token 不过期，用户撤销授权才失效。email provider 恒缺省。
   */
  providerAccessToken?: string;
  /**
   * provider 返回的全部**已验证**邮箱，归一化小写（1.2.0 起）。`email` 是其中
   * 选定的主锚点（primary+verified 优先）；App 可用整个列表做账号对账——GitHub 上
   * 挂了多个验证邮箱、其中之一才是 App 账号邮箱的用户，只比对 `email` 会被误判为新人。
   */
  verifiedEmails?: string[];
  requestMeta: { ip?: string; userAgent?: string };
}

export interface VerifiedResult {
  userId: string;
  isNewUser?: boolean;
  user?: unknown;
}

export type OnVerified = (
  identity: VerifiedIdentity
) => Promise<VerifiedResult> | VerifiedResult;

/**
 * onLinked：**已登录用户绑定第二身份**的语义出口（1.2.0 起）。
 * 与 onVerified 方向相反——onVerified **返回** userId（用外部身份换会话），
 * onLinked **接收** userId（用已有会话认领外部身份）；不建会话、不发 token。
 */
export interface LinkedIdentity {
  /** 当前登录用户，来自 link/start 的 Bearer 校验并存于 state；绝不接受客户端传入 */
  userId: string;
  provider: "github";
  providerUserId: string;
  /**
   * link 时 userId 已确定，email 只是附加信息——provider 未给也**不构成失败**
   * （与 onVerified 不同：那里 email 是账号锚点，缺了就无法找号建号）。
   */
  email?: string;
  verifiedEmails?: string[];
  providerProfile?: unknown;
  providerAccessToken?: string;
  requestMeta: { ip?: string; userAgent?: string };
}

/**
 * 冲突用返回值而非抛错表达：「该外部身份已属他人」是预期业务结果，不是异常
 * （抛错留给真异常 → `internal`）。库不裁决冲突——拒绝/换绑/重复绑定是否幂等
 * 全由 App 决定，库只把 `reason` 映射成回跳参数。
 * `reason` 须为 `[A-Za-z0-9_]{1,64}`，否则回落为 `internal`（回跳 URL 卫生）。
 */
export type LinkResult = { ok: true } | { ok: false; reason: string };

export type OnLinked = (
  identity: LinkedIdentity
) => Promise<LinkResult> | LinkResult;

// onEvent：结构化事件出口（refresh 的 rescued / reuse_revoked / guardrail_revoked 等），
// 默认实现为单行 JSON console.log（配合 Workers Logs）。字段永不含 token/code 明文。
export type OnEvent = (event: Record<string, unknown>) => void;

export interface GithubSocialConfig {
  clientId: string;
  clientSecret: string;
  /**
   * OAuth 回跳 deepLink 白名单，如 ["trendingai://auth"]。
   * 结构化匹配：scheme + host 精确一致，path 允许前缀扩展（防开放重定向）。
   */
  allowedRedirects: string[];
  /** GitHub OAuth App 注册的回调地址；缺省由请求 origin + basePath 推导 */
  callbackUrl?: string;
  /**
   * authorize 的 scope，默认 `user:email`——取 primary+verified 邮箱的最小集。
   * 需要额外能力的消费方自配，如 TrendingAI 的 `"user:email public_repo"`
   * （star 写操作要求 public_repo）。scope 越大授权页越吓人，按需给。
   */
  scope?: string;
}

export interface LoginConfig {
  db: D1Database;
  kv: KVNamespace;
  jwt: {
    secret: string;
    /** access token TTL，默认 3600s */
    accessTtlSeconds?: number;
  };
  email: EmailConfig;
  session?: {
    /** refresh 会话滑动过期（每次轮换重新起算）；null/缺省 = 不过期 */
    refreshTtlMs?: number | null;
  };
  /**
   * 登录统计（方案见 docs/stats-design.md）。事件写入 `db` 的 `auth_events` 表，
   * 不引入新 binding、不加依赖。
   *
   * **默认开启**——数据不能补录，忘配开关就是白丢一段时期的数据；代价（升级后
   * 未跑 migration 0002）由 stats.ts 的三条 fail-safe 兜住：异常吞掉、异步写、
   * 首次失败告警一次。
   */
  stats?: {
    /** 默认 true；置 false 则一条统计都不写 */
    enabled?: boolean;
  };
  /**
   * 应用商店审核用的演示账号：命中该邮箱时跳过限流、发信与 KV，固定码可无限次
   * 重复使用。无密码登录交不出商店要的静态凭据，TrendingAI 1.4.1 因此被 Play 拒过。
   * **未配置即完全不存在这条路径。**
   *
   * 该码等同这个账号的永久密码：**必须走 secret、不得入库**，且**不能用真实用户的
   * 邮箱**（否则谁拿到码就能登进那个真人的账号）。
   *
   * ⚠️ 已知可暴破（6 位固定码 + verify 无限流），2026-08-22 知情接受。
   * 完整行为契约、敞口与收口做法见 `docs/protocol.md` 的「演示账号」一节。
   */
  demoAccount?: {
    /** 比对时 trim + 转小写 */
    email: string;
    /** 与真码同形（6 位数字），客户端才无需特判 */
    code: string;
  };
  onVerified: OnVerified;
  /** 提供后才启用 link 端点（未提供 → 404 not_configured，默认关闭、显式启用） */
  onLinked?: OnLinked;
  onEvent?: OnEvent;
  socials?: { github?: GithubSocialConfig };
}

export interface CreateLoginOptions {
  /** 路由前缀，默认 "/auth"。静态选项（Hono app 构建期即需要），不进 env-依赖的 config。 */
  basePath?: string;
}

// Workers 的 binding 只在请求期以 env 出现，模块顶层拿不到；resolver 让库在
// 请求时取配置，并按 env 对象记忆化（同一 isolate 内 env 恒定，WeakMap 即缓存）。
export function memoizeResolver<TEnv>(
  resolve: (env: TEnv) => LoginConfig
): (env: TEnv) => LoginConfig {
  const cache = new WeakMap<object, LoginConfig>();
  return (env: TEnv): LoginConfig => {
    if (typeof env !== "object" || env === null) return resolve(env);
    const cached = cache.get(env);
    if (cached) return cached;
    const cfg = resolve(env);
    cache.set(env, cfg);
    return cfg;
  };
}
