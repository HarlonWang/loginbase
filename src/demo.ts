// 应用商店审核用的演示账号，见 LoginConfig.demoAccount 与 docs/protocol.md。
// verify 命中演示码时**替审核员把码写进 KV 再放行**，让常规 handler 自己验过去——
// 建会话与发事件因此只有常规路径那一份实现，不会漂移。
import type { Context, Hono } from "hono";
import { trimmedField } from "./body.js";
import { storeCode } from "./code.js";
import type { LoginConfig } from "./config.js";
import type { AuthVariables } from "./middleware.js";
import type { createTracker } from "./stats.js";

type DemoContext = Context<{ Variables: AuthVariables }>;
type Track = ReturnType<typeof createTracker>;

/** 演示邮箱判定。未配置恒 false，即这条路径完全不存在。 */
function hitsDemo(config: LoginConfig, email: string): boolean {
  const demo = config.demoAccount;
  return !!demo && demo.email.trim().toLowerCase() === email;
}

/** 与 handler 同一套归一化，否则大小写/空格会导致这里判不中而那里判中 */
async function readEmailAndCode(c: DemoContext) {
  const body = await c.req
    .json<{ email?: string; code?: string }>()
    .catch(() => ({}) as { email?: string; code?: string });
  return {
    email: trimmedField(body.email).toLowerCase(),
    code: trimmedField(body.code),
  };
}

/**
 * ⚠️ **必须在两个 `/code/*` 路由之前调用**：Hono 后注册的 `use` 拦不住已注册的
 * handler，挪到后面会静默失效（不报错，演示账号直接登不进去）。有测试守着。
 */
export function registerDemoAccount<TEnv>(
  auth: Hono<{ Variables: AuthVariables }>,
  getConfig: (env: TEnv) => LoginConfig,
  track: Track
): void {
  auth.use("/code/send", async (c, next) => {
    const config = getConfig(c.env as TEnv);
    if (!config.demoAccount) return next();

    const { email } = await readEmailAndCode(c as DemoContext);
    if (!hitsDemo(config, email)) return next();

    track(c as DemoContext, { event: "code_sent", meta: { demo: true } });
    // 必须与常规成功响应逐字节相同，否则一次请求就能认出演示账号
    return c.json({ cooldownSeconds: 60 }, 200);
  });

  auth.use("/code/verify", async (c, next) => {
    const config = getConfig(c.env as TEnv);
    const demo = config.demoAccount;
    if (!demo) return next();

    const { email, code } = await readEmailAndCode(c as DemoContext);
    if (!hitsDemo(config, email)) return next();

    if (code !== demo.code) {
      // 不能放行：常规路径的 readCode 未必为空（启用前这个邮箱可能发过码），
      // 读到就会返回 invalid_code 并改动那条残留记录。demo 标记只进事件、不出网。
      track(c as DemoContext, {
        event: "code_verify",
        outcome: "code_not_found",
        meta: { demo: true },
      });
      return c.json({ error: "code_expired" }, 400);
    }

    // 替审核员填好码，其余交给常规 handler；它会焚掉，下次登录再写一条
    await storeCode(config.kv, email, code);
    return next();
  });
}
