import type { EmailConfig } from "./email.js";

// onVerified：库与 App 的唯一用户语义边界。身份确认成功后调用；
// 返回的 isNewUser / user 原样透传进 verify / oauth exchange 响应。
// 抛错 → 500 internal（验证码已焚；会话在钩子成功后才创建，不留孤儿 session）。
export interface VerifiedIdentity {
  email: string;
  provider: "email" | "github";
  providerUserId?: string;
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
  onVerified: OnVerified;
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
