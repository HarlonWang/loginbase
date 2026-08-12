import type { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { memoizeResolver, type CreateLoginOptions, type LoginConfig } from "./config.js";
import { createAuthApp } from "./handler.js";
import { createAuthMiddleware, type AuthVariables } from "./middleware.js";

export interface Login<TEnv> {
  /** Hono 实例（已含 basePath）。Hono 消费方：app.route("/", login.app) */
  app: Hono<{ Variables: AuthVariables }>;
  /** 裸 JS Worker 一行挂载：if (pathname.startsWith("/auth")) return login.fetch(req, env, ctx) */
  fetch: (
    request: Request,
    env: TEnv,
    ctx?: ExecutionContext
  ) => Response | Promise<Response>;
  /** Hono 中间件：Bearer 校验，set userId / sessionId */
  middleware: MiddlewareHandler<{ Variables: AuthVariables }>;
}

export function createLogin<TEnv = unknown>(
  resolve: (env: TEnv) => LoginConfig,
  options: CreateLoginOptions = {}
): Login<TEnv> {
  const getConfig = memoizeResolver(resolve);
  const app = createAuthApp(getConfig, options.basePath ?? "/auth");
  return {
    app,
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    middleware: createAuthMiddleware(getConfig),
  };
}

export type {
  LoginConfig,
  CreateLoginOptions,
  VerifiedIdentity,
  VerifiedResult,
  OnVerified,
  OnEvent,
  GithubSocialConfig,
} from "./config.js";
export type { AuthVariables } from "./middleware.js";
export { createAuthMiddleware } from "./middleware.js";

// 底层模块出口：verifyAccessToken 供裸 Worker 的 requireAuth 双轨；
// session/code 等出口供消费方测试工具（如 Tono test/helpers）复用。
export * from "./code.js";
export * from "./email.js";
export * from "./rate_limit.js";
export * from "./session.js";
export * from "./token.js";
export { logEvent } from "./log.js";
