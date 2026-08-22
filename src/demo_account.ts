// 应用商店审核用的演示账号，见 LoginConfig.demoAccount 与 docs/protocol.md。
// 唯一的行为分叉在 /code/send：命中演示邮箱时验证码恒为固定值、不真实发信；
// 存码、限流、verify、建会话全走常规路径，固定码因此同样受 600s 过期、
// 错 5 次即焚、send 三层限流约束——演示账号不是旁路，只是码不随机的普通账号。
import type { LoginConfig } from "./config.js";

/** 解析该邮箱是否命中演示账号：命中返回解析结果，否则 null。
 *  email 须已 trim+小写。未配置恒 null。 */
export function matchDemoAccount(
  config: LoginConfig,
  email: string
): { code: string } | null {
  const demo = config.demoAccount;
  if (!demo || demo.email.trim().toLowerCase() !== email) return null;
  const code = demo.code.trim();
  // 配错的码（空串/非 6 位数字）视同未配置：verify 把缺失的 code 字段读成
  // 空串，空演示码等于免凭据登录——宁可演示账号登不进，也不能开这个口
  return /^\d{6}$/.test(code) ? { code } : null;
}
