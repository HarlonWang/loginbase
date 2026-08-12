import type { EmailConfig } from "./email";

export interface LoginConfig {
  db: D1Database;
  kv: KVNamespace;
  jwt: { secret: string };
  email: EmailConfig;
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
