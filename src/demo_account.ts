// 应用商店审核用的演示账号，见 LoginConfig.demoAccount 与 docs/protocol.md。
// 唯一的行为分叉在 /code/send：命中演示邮箱时验证码恒为固定值、不真实发信；
// 存码、限流、verify、建会话全走常规路径，固定码因此同样受 600s 过期、
// 错 5 次即焚、send 三层限流约束——演示账号不是旁路，只是码不随机的普通账号。
import type { LoginConfig } from "./config.js";

/** 命中演示邮箱返回固定码，否则 null。email 须已 trim+小写。未配置恒 null。 */
export function demoAccountCode(config: LoginConfig, email: string): string | null {
  const demo = config.demoAccount;
  if (!demo || demo.email.trim().toLowerCase() !== email) return null;
  return demo.code;
}
