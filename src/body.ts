/**
 * 请求体字段取字符串。
 *
 * JSON 里客户端可以塞任意类型，而 `(body.x ?? "").trim()` 遇到数字/对象/数组会抛
 * TypeError——把一个本该 400 的坏请求变成 500：日志噪音，且给客户端「服务端故障、
 * 可重试」的错误信号（实际重试多少次都一样）。TS 的字段类型只在编译期成立，
 * 运行时边界必须自己兜（见 design.md 技术选型第 1 条）。
 *
 * 非字符串一律当空串，让各端点照常走自己的 400 分支。
 */
export function trimmedField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
