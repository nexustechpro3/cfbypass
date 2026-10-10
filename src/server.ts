import express from 'express'
import cors from 'cors'
import path from 'path'
import { isReady } from './pool/browserPool'
import { get as getStats } from './services/stats'
import { getStats as proxyStats } from './services/proxyManager'
import { poolSize } from './pool/contextPool'
import { currentHeapMb } from './pool/memoryManager'
import router from './router'

const app = express()
const START_TIME = Date.now()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// ── Health endpoint — Amendment 15: responds IMMEDIATELY, before browser pool init ──
// This must be registered BEFORE the router and any guard middleware
app.get('/health', (req, res) => {
  const s = getStats()
  const p = proxyStats()
  res.json({
    success: true,
    data: {
      status: isReady() ? 'ready' : 'starting',
      queue: global.browserLength ?? 0,
      pool: {
        busy: global.browserLength ?? 0,
        total: global.browserLimit ?? 20,
        pooled: poolSize(),
      },
      memMb: currentHeapMb(),
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      total: s.total,
      success: s.success,
      failed: s.failed,
      avgMs: s.avgMs,
      proxies: p,
    },
  })
})

// Stats endpoint
app.get('/stats', (req, res) => {
  res.json({ success: true, data: { solveStats: getStats(), proxyStats: proxyStats() } })
})

// Serve static UI pages
const PUBLIC_DIR = path.resolve(__dirname, '../public')
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')))
app.get('/test', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'test.html')))
app.get('/usage', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'usage.html')))

// API routes
app.use('/', router)

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } })
})

export default app
