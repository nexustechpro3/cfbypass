import 'dotenv/config'
import http from 'http'
import net from 'net'
import { URL } from 'url'
import app from './server'
import { init as initBrowser, shutdown as shutdownBrowser } from './pool/browserPool'
import { warmPool } from './pool/contextPool'
import { start as startMemoryManager, stop as stopMemoryManager } from './pool/memoryManager'
import { init as initProxyManager, stop as stopProxyManager } from './services/proxyManager'

const PORT = parseInt(process.env.PORT || '3000', 10)
const PROXY_PASSWORD = process.env.SERVER_PROXY_PASSWORD || 'changeme'

function isAuthorizedBasic(req: http.IncomingMessage): boolean {
  const header = req.headers['proxy-authorization'] || ''
  if (!header.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice(6), 'base64').toString()
  const [, pass] = decoded.split(':')
  return pass === PROXY_PASSWORD
}

function isAuthorizedHeader(req: http.IncomingMessage): boolean {
  const password = req.headers['x-proxy-password'] as string
  return password === PROXY_PASSWORD
}

function isAuthorized(req: http.IncomingMessage): boolean {
  return isAuthorizedBasic(req) || isAuthorizedHeader(req)
}

async function start(): Promise<void> {
  const server = http.createServer(app)

  // ── HTTP proxy requests (Railway / any platform) ───────────────────────────
  server.on('request', (req, res) => {
    // Only intercept absolute URLs — let Express handle everything else
    if (!req.url?.startsWith('http')) return

    if (!isAuthorized(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Proxy"' })
      res.end('Proxy Authentication Required')
      return
    }

    const target = new URL(req.url)
    const options: http.RequestOptions = {
      hostname: target.hostname,
      port: parseInt(target.port) || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...req.headers, host: target.hostname },
    }

    const proxy = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode!, proxyRes.headers)
      proxyRes.pipe(res)
    })

    proxy.on('error', (err) => {
      console.error('[Proxy] HTTP request error:', err.message)
      res.writeHead(502)
      res.end('Bad Gateway')
    })

    req.pipe(proxy)
  })

  // ── HTTPS CONNECT tunneling (VPS / raw TCP supported platforms) ────────────
  server.on('connect', (req, clientSocket, head) => {
    if (!isAuthorized(req)) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\n\r\n')
      clientSocket.destroy()
      return
    }

    const [host, portStr] = (req.url ?? '').split(':')
    const port = parseInt(portStr) || 443

    const serverSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      serverSocket.write(head)
      serverSocket.pipe(clientSocket)
      clientSocket.pipe(serverSocket)
    })

    serverSocket.on('error', (err) => {
      console.error('[Proxy] CONNECT error:', err.message)
      clientSocket.destroy()
    })

    clientSocket.on('error', () => serverSocket.destroy())
  })

  await new Promise<void>(resolve => {
    server.listen(PORT, () => {
      console.log(`[NexusClearance] Server + Proxy listening on port ${PORT}`)
      resolve()
    })
  })

  server.timeout = global.timeOut

  initProxyManager()
  startMemoryManager()

  try {
    await initBrowser()
    await warmPool()
    console.log('[NexusClearance] Ready')
  } catch (err) {
    console.error('[NexusClearance] Browser init failed:', err)
    setTimeout(() => {
      initBrowser()
        .then(() => warmPool())
        .then(() => console.log('[NexusClearance] Browser ready (retry)'))
        .catch(e => console.error('[NexusClearance] Browser retry failed:', e))
    }, 5000)
  }

  async function shutdown(signal: string): Promise<void> {
    console.log(`[NexusClearance] ${signal} received — shutting down`)
    stopMemoryManager()
    stopProxyManager()
    await shutdownBrowser()
    server.close(() => {
      console.log('[NexusClearance] HTTP server closed')
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10000)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start().catch(err => {
  console.error('[NexusClearance] Fatal startup error:', err)
  process.exit(1)
})