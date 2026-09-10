import 'dotenv/config'
import http from 'http'
import app from './server'
import { init as initBrowser, shutdown as shutdownBrowser } from './pool/browserPool'
import { warmPool } from './pool/contextPool'
import { start as startMemoryManager, stop as stopMemoryManager } from './pool/memoryManager'
import { init as initProxyManager, stop as stopProxyManager } from './services/proxyManager'

const PORT = parseInt(process.env.PORT || '3000', 10)

async function start(): Promise<void> {
  // Amendment 15: Start HTTP server FIRST — health check must respond before browser is ready
  const server = http.createServer(app)

  await new Promise<void>(resolve => {
    server.listen(PORT, () => {
      console.log(`[Nexuscfbypass] Server listening on port ${PORT}`)
      resolve()
    })
  })

  server.timeout = global.timeOut

  // Now init everything else in the background
  // Health endpoint already responding — Railway health check will pass
  initProxyManager()
  startMemoryManager()

  try {
    await initBrowser()
    await warmPool()
    console.log('[Nexuscfbypass] Ready')
  } catch (err) {
    console.error('[Nexuscfbypass] Browser init failed:', err)
    // Don't crash — let health endpoint report "starting" until retry
    // Retry after 5s
    setTimeout(() => {
      initBrowser()
        .then(() => warmPool())
        .then(() => console.log('[Nexuscfbypass] Browser ready (retry)'))
        .catch(e => console.error('[Nexuscfbypass] Browser retry failed:', e))
    }, 5000)
  }

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    console.log(`[Nexuscfbypass] ${signal} received — shutting down`)
    stopMemoryManager()
    stopProxyManager()
    await shutdownBrowser()
    server.close(() => {
      console.log('[Nexuscfbypass] HTTP server closed')
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10000)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

start().catch(err => {
  console.error('[Nexuscfbypass] Fatal startup error:', err)
  process.exit(1)
})
