import { serve } from '@hono/node-server'
import { IncomingMessage } from 'node:http'
import app from './index.js'

const port = Number(process.env.PORT) || 8317
const DASHBOARD_API_URL = (process.env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')

console.log(`Cortex Hub MCP Server starting on port ${port}...`)

/**
 * Validate Bearer token from query string or Authorization header.
 * Returns { valid, agentId } or { valid: false, error }.
 */
async function validateWsAuth(req: IncomingMessage): Promise<{ valid: boolean; agentId?: string; error?: string }> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  // Try apiKey from query param first, then Authorization header
  let token = url.searchParams.get('apiKey') || ''
  if (!token) {
    const authHeader = req.headers['authorization'] || ''
    const [scheme, t] = authHeader.split(' ')
    if (scheme?.toLowerCase() === 'bearer' && t) token = t
  }

  if (!token) {
    return { valid: false, error: 'Missing API key. Use ?apiKey=xxx or Authorization: Bearer xxx' }
  }

  try {
    const res = await fetch(`${DASHBOARD_API_URL}/api/keys/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) return { valid: false, error: 'Invalid API key' }
    const data = await res.json() as { valid: boolean; agentId?: string; error?: string }
    return data.valid ? { valid: true, agentId: data.agentId } : { valid: false, error: data.error || 'Auth failed' }
  } catch (err) {
    return { valid: false, error: `Auth service unavailable: ${String(err)}` }
  }
}

const server = serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`MCP Gateway running at http://localhost:${info.port}`)
  console.log(`WebSocket proxy: ws://localhost:${info.port}/ws/conductor`)
})

// ── WebSocket proxy: /ws/conductor → dashboard-api ──
// Same auth as MCP (Bearer API key), exposed on same port.
// Agents connect here instead of directly to dashboard-api.
server.on('upgrade', async (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  // Only handle /ws/ paths
  if (!url.pathname.startsWith('/ws/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }

  // Validate API key
  const auth = await validateWsAuth(req)
  if (!auth.valid) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\n${auth.error}`)
    socket.destroy()
    return
  }

  console.log(`[WS Proxy] Upgrading ${url.pathname} for agent=${auth.agentId || 'unknown'}`)

  // Proxy the upgrade to dashboard-api
  const targetUrl = `${DASHBOARD_API_URL.replace('http', 'ws')}${url.pathname}${url.search}`
  try {
    const ws = await import('ws')
    const WS = ws.default
    const WSServer = ws.WebSocketServer
    const upstream = new WS(targetUrl)

    upstream.on('open', () => {
      // Forward the original upgrade to create a client-side WS
      const wss = new WSServer({ noServer: true })
      wss.handleUpgrade(req, socket, head, (clientWs: InstanceType<typeof WS>) => {
        console.log(`[WS Proxy] Connected: agent=${auth.agentId}, path=${url.pathname}`)

        // Bidirectional relay
        clientWs.on('message', (data: Buffer) => {
          if (upstream.readyState === WS.OPEN) upstream.send(data)
        })
        upstream.on('message', (data: Buffer) => {
          if (clientWs.readyState === WS.OPEN) clientWs.send(data)
        })

        clientWs.on('close', (code: number) => {
          console.log(`[WS Proxy] Client disconnected: agent=${auth.agentId}, code=${code}`)
          upstream.close()
        })
        upstream.on('close', (code: number) => {
          console.log(`[WS Proxy] Upstream disconnected: code=${code}`)
          clientWs.close()
        })

        clientWs.on('error', (err: Error) => {
          console.error(`[WS Proxy] Client error:`, err.message)
          upstream.close()
        })
        upstream.on('error', (err: Error) => {
          console.error(`[WS Proxy] Upstream error:`, err.message)
          clientWs.close()
        })
      })
    })

    upstream.on('error', (err: Error) => {
      console.error(`[WS Proxy] Failed to connect upstream:`, err.message)
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
    })
  } catch (err) {
    console.error(`[WS Proxy] Error:`, err)
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
    socket.destroy()
  }
})
