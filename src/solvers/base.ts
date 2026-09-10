import { BrowserContext, Page } from 'patchright'
import { borrow, returnCtx } from '../pool/contextPool'
import type { ProxyConfig, CookieParam } from '../types'
import {
  CF_POLL_INTERVAL_MS,
  CLEARANCE_POLL_INTERVAL_MS,
  TOKEN_POLL_INTERVAL_MS,
} from '../constants'

const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '120000', 10)

// --- Polling helpers ---

/** Polls page title/body text until CF challenge text is gone. */
export async function waitForCF(page: Page, ms = 30000): Promise<boolean> {
  const deadline = Date.now() + ms
  const CF_TEXTS = [
    'Just a moment',
    'Checking your browser',
    'DDoS-Guard',
    'Please wait',
    'Verifying you are human',
    'Security check',
  ]

  while (Date.now() < deadline) {
    try {
      const [title, bodyText] = await Promise.all([
        page.title().catch(() => ''),
        page.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
      ])

      const combined = (title + ' ' + bodyText).toLowerCase()
      const isChallenge = CF_TEXTS.some(t => combined.includes(t.toLowerCase()))
      if (!isChallenge) return true
    } catch (_) { /* page may be navigating */ }

    await sleep(CF_POLL_INTERVAL_MS)
  }
  return false
}

/** Polls context cookies until cf_clearance appears — definitive CF-solved signal. */
export async function waitForClearance(page: Page, ms = 90000): Promise<string | null> {
  const deadline = Date.now() + ms

  while (Date.now() < deadline) {
    try {
      const cookies = await page.context().cookies()
      const c = cookies.find(ck => ck.name === 'cf_clearance')
      if (c?.value) return c.value
    } catch (_) { /* ignore */ }

    await sleep(CLEARANCE_POLL_INTERVAL_MS)
  }
  return null
}

/** Polls for Turnstile token via hidden input or window.turnstile.getResponse(). */
export async function waitForToken(page: Page, ms = 60000): Promise<string | null> {
  const deadline = Date.now() + ms

  while (Date.now() < deadline) {
    try {
      const token = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[name="cf-response"]')
        if (input?.value && input.value.length > 10) return input.value
        const turnstile = (window as unknown as { turnstile?: { getResponse(): string } }).turnstile
        if (turnstile) {
          const t = turnstile.getResponse()
          if (t && t.length > 10) return t
        }
        return null
      })

      if (token) return token
    } catch (_) { /* ignore during navigation */ }

    await sleep(TOKEN_POLL_INTERVAL_MS)
  }
  return null
}

// --- Context helpers ---

/** Creates a fresh browser context with optional proxy. */
export async function mkCtx(proxy?: ProxyConfig): Promise<BrowserContext> {
  return borrow(proxy)
}

/** Sets up a page: Sec-Fetch headers only. NO evasion scripts — Patchright handles at binary level. */
export async function setupPage(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders({
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
  })
}

/**
 * Wraps a browser context with timeout, cleanup, and error handling.
 * Context-per-request with race between solver timeout and global context timeout.
 */
export async function withCtx<T>(
  proxy: ProxyConfig | undefined,
  fn: (ctx: BrowserContext) => Promise<T>
): Promise<T> {
  const ctx = await borrow(proxy)
  let hadError = false

  // Listen for new pages created inside this context — call setupPage on each
  ctx.on('page', async (newPage: Page) => {
    try {
      await setupPage(newPage)
    } catch (_) { /* ignore */ }
  })

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Solver timeout')), TIMEOUT_MS)
  )

  try {
    const result = await Promise.race([fn(ctx), timeout])
    return result
  } catch (err) {
    hadError = true
    throw err
  } finally {
    await returnCtx(ctx, hadError)
  }
}

// --- Page interaction helpers ---

/** Tries page.click first, falls back to evaluate click if element not interactable. */
export async function safeClick(page: Page, selector: string): Promise<void> {
  try {
    await page.click(selector, { timeout: 5000 })
  } catch (_) {
    await page.evaluate((sel) => {
      const el = document.querySelector<HTMLElement>(sel)
      el?.click()
    }, selector)
  }
}

/** Types into a field with delay, verifies value, retypes if mismatch. */
export async function typeField(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: 10000 })
  await page.click(selector)
  await page.keyboard.press('Control+a')
  await sleep(50)
  await page.keyboard.type(value, { delay: 50 })
  // Verify typed value
  const actual = await page.evaluate((sel) => {
    const el = document.querySelector<HTMLInputElement>(sel)
    return el?.value ?? ''
  }, selector)
  if (actual !== value) {
    // Retype
    await page.click(selector)
    await page.keyboard.press('Control+a')
    await page.keyboard.type(value, { delay: 80 })
  }
}

// --- Cookie helpers ---

/** Convert our CookieParam to Playwright's addCookies format */
export function toPwCookies(url: string, cookies: CookieParam[]): Array<{
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}> {
  const domain = new URL(url).hostname
  return cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain ?? domain,
    path: c.path ?? '/',
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }))
}

/** Convert Playwright Cookie[] to our CookieParam[] */
export function fromPwCookies(cookies: Array<{
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}>): CookieParam[] {
  return cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }))
}

// --- Utility ---

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Build proxy URL string from ProxyConfig */
export function buildProxyUrl(proxy: ProxyConfig): string {
  const scheme = proxy.protocol ?? 'http'
  if (proxy.username && proxy.password) {
    return `${scheme}://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
  }
  return `${scheme}://${proxy.host}:${proxy.port}`
}
