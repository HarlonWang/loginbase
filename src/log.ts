// 结构化事件日志：输出一行 JSON，便于 Cloudflare Workers Logs 过滤与聚合。
// observability 已在 wrangler.toml 开启（head_sampling_rate 1.0）。
export function logEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}
