import { BrowserContext } from 'patchright'
import { getBrowser } from './browserPool'
import type { ProxyConfig } from '../types'

// Amendment 11: default pool size is 1 (not 3). Each context is 300–500MB.
const POOL_SIZE = parseInt(process.env.CONTEXT_POOL_SIZE || '1', 10)  // Amendment 14: parseInt

const pool: BrowserContext[] = []
let initializing = false

function buildProxyOption(proxy?: ProxyConfig): { server: string; username?: string; password?: string } | undefined {
  if (!proxy) return undefined
  const scheme = proxy.protocol ?? 'http'
  const server = `${scheme}://${proxy.host}:${proxy.port}`
  return {
    server,
    username: proxy.username,
    password: proxy.password,
  }
}

async function createContext(proxy?: ProxyConfig): Promise<BrowserContext> {
  const browser = getBrowser()
  const ctx = await browser.newContext({
    proxy: buildProxyOption(proxy),
    userAgent: undefined, // Patchright sets its own — do NOT override
  })
  return ctx
}

export async function warmPool(): Promise<void> {
  if (initializing) return
  initializing = true
  const toFill = Math.max(0, POOL_SIZE - pool.length)
  for (let i = 0; i < toFill; i++) {
    try {
      const ctx = await createContext()
      pool.push(ctx)
    } catch (err) {
      console.error('[ContextPool] Failed to warm context:', err)
    }
  }
  initializing = false
  console.log(`[ContextPool] Pool warmed: ${pool.length}/${POOL_SIZE}`)
}

/** Borrow a context. Returns a fresh one if pool is empty. */
export async function borrow(proxy?: ProxyConfig): Promise<BrowserContext> {
  // If proxy is specified, always create a fresh context (proxy is per-context)
  if (proxy) {
    return createContext(proxy)
  }

  const ctx = pool.pop()
  if (ctx && !ctx.pages().every(p => p.isClosed())) {
    return ctx
  }
  if (ctx) {
    // Context is stale — close it silently
    ctx.close().catch(() => { /* ignore */ })
  }
  return createContext()
}

/** Return context to pool after successful use. Destroy it on error. */
export async function returnCtx(ctx: BrowserContext, hadError: boolean): Promise<void> {
  if (hadError) {
    ctx.close().catch(() => { /* ignore */ })
    return
  }
  if (pool.length < POOL_SIZE) {
    pool.push(ctx)
  } else {
    ctx.close().catch(() => { /* ignore */ })
  }
}

/** Drain all pooled contexts — called by memoryManager on high memory. */
export async function drain(): Promise<void> {
  const contexts = pool.splice(0, pool.length)
  await Promise.allSettled(contexts.map(c => c.close()))
  console.log('[ContextPool] Pool drained')
}

export function poolSize(): number {
  return pool.length
}
