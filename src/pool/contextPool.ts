import { BrowserContext, chromium, Page } from 'patchright'
import { getPersistentContext } from './browserPool'
import type { ProxyConfig } from '../types'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { randomUUID } from 'crypto'

const POOL_SIZE = parseInt(process.env.CONTEXT_POOL_SIZE || '1', 10)

// Registry: requestId → Page — each request owns exactly one page by UUID
const pageRegistry = new Map<string, Page>()

export interface BorrowResult {
  ctx: BrowserContext
  requestId: string
}

export async function borrow(proxy?: ProxyConfig): Promise<BorrowResult> {
  const requestId = randomUUID()

  if (proxy) {
    const tmpDir = path.join(os.tmpdir(), `nexus-proxy-${requestId}`)

    const IS_LINUX = process.platform === 'linux'
    const LINUX_FLAGS = IS_LINUX ? [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--noerrdialogs',
    ] : []

    const ctx = await chromium.launchPersistentContext(tmpDir, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: [
        ...LINUX_FLAGS,
        '--disable-save-password-bubble',
        '--disable-single-click-autofill',
        '--disable-autofill-keyboard-accessory-view',
        '--password-store=basic',
        '--disable-features=AutofillServerCommunication,AutofillEnableAccountWalletStorage,PasswordManager',
      ],
      proxy: {
        server: `${proxy.protocol ?? 'socks5'}://${proxy.host}:${proxy.port}`,
        ...(proxy.username ? { username: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {}),
      }
    })
    return { ctx, requestId }
  }

  return { ctx: getPersistentContext(), requestId }
}

export function registerPage(requestId: string, page: Page): void {
  pageRegistry.set(requestId, page)
  // Auto-accept any browser dialogs (alerts, confirms, prompts)
  page.on('dialog', dialog => dialog.accept().catch(() => { }))
}

export async function returnCtx(
  ctx: BrowserContext,
  hadError: boolean,
  requestId: string
): Promise<void> {
  // Get the exact page this request opened
  const page = pageRegistry.get(requestId)
  pageRegistry.delete(requestId)

  let persistent: BrowserContext | null = null
  try { persistent = getPersistentContext() } catch (_) { }

  if (ctx === persistent) {
    if (page && !page.isClosed()) {
      // 1. Wipe cookies, localStorage, and sessionStorage for the active page
      try {
        const url = page.url()
        if (url && !url.startsWith('about:')) {
          const parsed = new URL(url)
          const origin = parsed.origin
          const hostname = parsed.hostname

          // Clear client storage in the page
          await page.evaluate(() => {
            try { localStorage.clear() } catch (_) { }
            try { sessionStorage.clear() } catch (_) { }
          }).catch(() => { })

          // Use Chrome DevTools Protocol to clear all data for this origin (cookies, indexeddb, storage)
          try {
            const client = await ctx.newCDPSession(page)
            await client.send('Storage.clearDataForOrigin', {
              origin,
              storageTypes: 'all',
            })
            await client.detach().catch(() => { })
          } catch (_) {
            // Fallback: clear cookies by domain matching
            await ctx.clearCookies({ domain: hostname }).catch(() => { })
            const parts = hostname.split('.')
            if (parts.length > 2) {
              await ctx.clearCookies({ domain: parts.slice(1).join('.') }).catch(() => { })
            }
          }
        }
      } catch (err) {
        console.warn('[ContextPool] Failed to clear page session data:', err)
      }

      const activePages = ctx.pages().filter(p => !p.isClosed())
      if (activePages.length <= 1) {
        // This is the last tab — wipe all context cookies and navigate to blank to keep browser alive
        await ctx.clearCookies().catch(() => { })
        await page.goto('about:blank').catch(() => { })
      } else {
        // Other requests still have active tabs — only close this one
        await page.close().catch(() => { })
      }
    }
    return
  }

  // Proxy context — close entirely and clean up its ephemeral folder
  await ctx.close().catch(() => { })
  try {
    const tmpDir = path.join(os.tmpdir(), `nexus-proxy-${requestId}`)
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  } catch (_) { }
}

export async function warmPool(): Promise<void> {
  console.log(`[ContextPool] Pool warmed: 1/${POOL_SIZE}`)
}

export async function drain(): Promise<void> {
  console.log('[ContextPool] Drain — persistent context stays alive')
}

export function poolSize(): number {
  try { getPersistentContext(); return 1 } catch { return 0 }
}