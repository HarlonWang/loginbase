// 应用商店审核用的演示账号。**全部逻辑都在本文件**——handler.ts 只负责在两个
// /code/* 路由注册之前调一次 registerDemoAccount，主流程一行不改。
//
// 核心手法：verify 命中演示码时，**替审核员把码写进 KV 再放行**，让常规 handler
// 自己验过去。于是建会话、发事件、响应形状全部复用常规路径那一份代码——
// 不存在「演示登录的会话」与「真实登录的会话」两套实现，构造上不可能漂移。
// 将来给会话加字段（设备指纹、改 TTL、加事件），演示这条路自动跟上。
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
 * 挂载演示账号中间件。
 *
 * ⚠️ **必须在 `/code/send`、`/code/verify` 两个 `auth.post` 之前调用**：Hono 里
 * 后注册的 `use` 拦不住已注册的 handler（实测），挪到后面会**静默失效**——
 * 演示账号会退化成一个登不进去的普通邮箱，而不会有任何报错。
 * 该约束由 demo_account.test.ts 的「注册顺序」用例守着。
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

    // 不发信、不写 KV、不计限流。放在这里（而非常规 handler 的限流之后）正是为了
    // 绕开「同 IP 10 次/3600s」——审核员反复试不能被挡住。
    track(c as DemoContext, { event: "code_sent", meta: { demo: true } });
    // 与常规成功响应**逐字节相同**：若返回 0，一次请求就能认出演示账号。
    // 审核员不需要重发（码固定），60 秒倒计时对他没有任何影响。
    return c.json({ cooldownSeconds: 60 }, 200);
  });

  auth.use("/code/verify", async (c, next) => {
    const config = getConfig(c.env as TEnv);
    const demo = config.demoAccount;
    if (!demo) return next();

    const { email, code } = await readEmailAndCode(c as DemoContext);
    if (!hitsDemo(config, email)) return next();

    if (code !== demo.code) {
      // **不能放行到常规路径**：那里 readCode 未必为空（启用 demoAccount 之前这个
      // 邮箱可能正常发过码），一旦读到，错码会返回 invalid_code / too_many_attempts
      // 而非契约承诺的 code_expired，且会改动甚至删掉那条残留记录。
      // 响应与「未发过码的普通邮箱」逐字节一致；demo 标记只进服务端事件，不出网。
      track(c as DemoContext, {
        event: "code_verify",
        outcome: "code_not_found",
        meta: { demo: true },
      });
      return c.json({ error: "code_expired" }, 400);
    }

    // 替审核员把码填好，其余交给常规 handler：它会 readCode 命中 → 焚码 →
    // onVerified → 建会话 → 签 token → 发事件。焚掉无妨，下次登录再写一条。
    await storeCode(config.kv, email, code);
    return next();
  });
}
