const KEPT = new Set([1000, 1001, 1008, 1011])

/**
 * Map an upstream WebSocket close code to one `ws` will accept in close().
 * Reserved codes (1005, 1006, 1015) and out-of-range codes make close() throw.
 */
export function forwardCloseCode(code: number): number {
  if (KEPT.has(code) || (code >= 3000 && code <= 4999)) return code
  if (code === 1005) return 1000
  return 1011
}
