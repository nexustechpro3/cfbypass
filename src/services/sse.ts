import type { SseSendFn } from '../types'
import { SSE_PING_INTERVAL_MS, SSE_STATS_INTERVAL_MS } from '../constants'
import { get as getStats } from './stats'
import { getStats as getProxyStats } from './proxyManager'
import { poolSize } from '../pool/contextPool'
import { currentHeapMb } from '../pool/memoryManager'

const clients = new Set<SseSendFn>()

export function addClient(send: SseSendFn): void {
  clients.add(send)
  try {
    send('stats', {
      queue: global.browserLength,
      pool: {
        busy: global.browserLength,
        total: global.browserLimit,
        pooled: poolSize(),
      },
      memMb: currentHeapMb(),
      solveStats: getStats(),
      proxyStats: getProxyStats(),
    })
    const pStats = getProxyStats()
    if (pStats) {
      send('proxy', pStats)
    }
  } catch (_) { /* client may have disconnected */ }
}

export function removeClient(send: SseSendFn): void {
  clients.delete(send)
}

export function broadcast(event: string, data: unknown): void {
  for (const send of clients) {
    try {
      send(event, data)
    } catch (_) { /* client may have disconnected */ }
  }
}

// Broadcast stats every 3s
const statsTimer = setInterval(() => {
  if (!clients.size) return
  broadcast('stats', {
    queue: global.browserLength,
    pool: {
      busy: global.browserLength,
      total: global.browserLimit,
      pooled: poolSize(),
    },
    memMb: currentHeapMb(),
    solveStats: getStats(),
    proxyStats: getProxyStats(),
  })
}, SSE_STATS_INTERVAL_MS)

// Ping every 25s — keeps connection alive through proxies
const pingTimer = setInterval(() => {
  if (!clients.size) return
  broadcast('ping', { t: Date.now() })
}, SSE_PING_INTERVAL_MS)

statsTimer.unref()
pingTimer.unref()
