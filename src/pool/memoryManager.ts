import { drain } from './contextPool'
import { restart } from './browserPool'

// Amendment 5: global.gc?.() with optional chaining — silently does nothing without --expose-gc
// Do NOT add --expose-gc to launch args — Railway does not allow it.

const POLL_INTERVAL_MS = 30_000
const LIMIT_MB = parseInt(process.env.MEMORY_LIMIT_MB || '1024', 10)

let _timer: NodeJS.Timeout | null = null

function heapMb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
}

async function check(): Promise<void> {
  const used = heapMb()

  if (used > LIMIT_MB * 1.5) {
    console.log(`[MemoryManager] CRITICAL: heap ${used}MB > ${LIMIT_MB * 1.5}MB — restarting browser`)
    try {
      await drain()
      ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
      await restart()
    } catch (err) {
      console.error('[MemoryManager] Restart failed:', err)
    }
    return
  }

  if (used > LIMIT_MB) {
    console.log(`[MemoryManager] WARNING: heap ${used}MB > ${LIMIT_MB}MB — draining context pool`)
    try {
      await drain()
      ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
    } catch (err) {
      console.error('[MemoryManager] Drain failed:', err)
    }
  }
}

export function start(): void {
  if (_timer) return
  _timer = setInterval(() => {
    check().catch(err => console.error('[MemoryManager] Check error:', err))
  }, POLL_INTERVAL_MS)
  _timer.unref()
  console.log('[MemoryManager] Watchdog started')
}

export function stop(): void {
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
}

export function currentHeapMb(): number {
  return heapMb()
}
