import { serve } from '@hono/node-server'
import type { IncomingMessage } from 'node:http'
import app from './index.js'
import { defaultBundlePath, serveWorkerAsset } from './worker-asset.js'
import { forwardCloseCode } from './ws-close.js'
import { withInternalSecret } from './internal-secret.js'
import { refusalStatus, validateWsAuth } from './ws-auth.js'

const port = Number(process.env.PORT) || 8317
const DASHBOARD_API_URL = (process.env.DASHBOARD_API_URL || 'http://localhost:4000').replace(/\/$/, '')
globalThis.fetch = withInternalSecret(globalThis.fetch, DASHBOARD_API_URL, process.env.INTERNAL_API_SECRET)

console.log(`Cortex Hub MCP Server starting on port ${port}...`)

const assetOpts = { bundlePath: defaultBundlePath(process.env, import.meta.url) }

const server = serve({
  fetch: async (req, env) => (await serveWorkerAsset(req, assetOpts)) ?? app.fetch(req, env),
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
  const auth = await validateWsAuth(req.url || '/', req.headers, DASHBOARD_API_URL)
  if (!auth.valid) {
    socket.write(`${refusalStatus(auth)}\r\nContent-Type: text/plain\r\n\r\n${auth.error}`)
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
          console.log(`[WS Proxy] Client → Upstream: ${data.toString().substring(0, 120)}`)
          if (upstream.readyState === WS.OPEN) upstream.send(data)
        })
        upstream.on('message', (data: Buffer) => {
          console.log(`[WS Proxy] Upstream → Client: ${data.toString().substring(0, 120)}`)
          if (clientWs.readyState === WS.OPEN) clientWs.send(data)
          else console.log(`[WS Proxy] DROPPED — clientWs not OPEN (state=${clientWs.readyState})`)
        })

        clientWs.on('close', (code: number) => {
          console.log(`[WS Proxy] Client disconnected: agent=${auth.agentId}, code=${code}`)
          upstream.close()
        })
        upstream.on('close', (code: number, reason: Buffer) => {
          console.log(`[WS Proxy] Upstream disconnected: code=${code}`)
          clientWs.close(forwardCloseCode(code), reason)
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
