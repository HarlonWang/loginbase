import type { MiddlewareHandler } from "hono";
import { jwtVerify } from "jose";
import type { LoginConfig } from "./config.js";

/** 演示账号请求标记的 context key，见 demo.ts 与 stats.ts */
export const DEMO_FLAG = "demoRequest";

export interface AuthVariables {
  userId: string;
  sessionId?: string;
  /** 由 demo.ts 种下，tracker 据此给本次请求的所有事件加 meta.demo */
  [DEMO_FLAG]?: true;
}

export function createAuthMiddleware<TEnv>(
  getConfig: (env: TEnv) => LoginConfig
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const token = header.slice(7);
    try {
      const secret = new TextEncoder().encode(getConfig(c.env as TEnv).jwt.secret);
      const { payload } = await jwtVerify(token, secret);
      c.set("userId", payload.sub as string);
      if (typeof payload.sid === "string") {
        c.set("sessionId", payload.sid);
      }
      await next();
    } catch {
      return c.json({ error: "Invalid token" }, 401);
    }
  };
}
