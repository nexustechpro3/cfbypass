import 'dotenv/config'
import http from 'http'
import net from 'net'
import app from './server'
import { init as initBrowser, shutdown as shutdownBrowser } from './pool/browserPool'
import { warmPool } from './pool/contextPool'
import { start as startMemoryManager, stop as stopMemoryManager } from './pool/memoryManager'
import { init as initProxyManager, stop as stopProxyManager } from './services/proxyManager'

const PORT = parseInt(process.env.PORT || '3000', 10)
const PROXY_PASSWORD = process.env.SERVER_PROXY_PASSWORD || 'changeme'

function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers['proxy-authorization'] || ''
  if (!header.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice(6), 'base64').toString()
  const [, pass] = decoded.split(':')
  return pass === PROXY_PASSWORD
}

async function start(): Promise<void> {
  const server = http.createServer(app)

  // ── Forward proxy on same port ─────────────────────────────────────────────
  server.on('connect', (req, clientSocket, head) => {
    if (!isAuthorized(req)) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\n\r\n')
      clientSocket.destroy()
      return
    }

    const [host, port] = (req.url ?? '').split(':')
    const serverSocket = net.connect(parseInt(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      serverSocket.write(head)
      serverSocket.pipe(clientSocket)
      clientSocket.pipe(serverSocket)
    })

    serverSocket.on('error', () => clientSocket.destroy())
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