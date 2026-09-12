import { BrowserContext, Page } from 'patchright'
import { borrow, returnCtx, registerPage } from '../pool/contextPool'
import type { ProxyConfig, CookieParam } from '../types'
import {
  CF_POLL_INTERVAL_MS,
  CLEARANCE_POLL_INTERVAL_MS,
  TOKEN_POLL_INTERVAL_MS,
} from '../constants'

// --- Polling helpers ---

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
      if (!CF_TEXTS.some(t => combined.includes(t.toLowerCase()))) return true
    } catch (_) { }
    await sleep(CF_POLL_INTERVAL_MS)
  }
  return false
}

export async function waitForClearance(page: Page, ms = 90000): Promise<string | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const cookies = await page.context().cookies()
      const c = cookies.find(ck => ck.name === 'cf_clearance')
      if (c?.value) return c.value
    } catch (_) { }
    await sleep(CLEARANCE_POLL_INTERVAL_MS)
  }
  return null
}

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
    } catch (_) { }
    await sleep(TOKEN_POLL_INTERVAL_MS)
  }
  return null
}

// --- Context helpers ---

/**
 * setupPage — intentionally empty.
 * setExtraHTTPHeaders applies to ALL requests (CSS/fonts/images) and breaks
 * subresource loading which causes blank pages. Patchright handles all
 * fingerprinting at the binary level.
 */
export async function setupPage(_page: Page): Promise<void> {
  // Intentionally empty — Patchright handles everything
}

/**
 * withCtx — the core request wrapper.
 * Each call gets a unique requestId. The page opened inside fn() is
 * registered by that requestId so returnCtx closes ONLY that page,
 * never touching concurrent requests' pages.
 */
export async function withCtx<T>(
  proxy: ProxyConfig | undefined,
  fn: (ctx: BrowserContext, requestId: string) => Promise<T>
): Promise<T> {
  const { ctx, requestId } = await borrow(proxy)
  let hadError = false

  try {
    return await fn(ctx, requestId)
  } catch (err) {
    hadError = true
    throw err
  } finally {
    await returnCtx(ctx, hadError, requestId)
  }
}

/**
 * withSessionOrCtx — routes to persistent session tab if req.sessionId is provided,
 * or borrows an ephemeral tab via withCtx if not.
 */
export async function withSessionOrCtx<T>(
  req: { sessionId?: string; proxy?: ProxyConfig; setCookies?: CookieParam[] },
  fn: (ctx: BrowserContext, page: Page, requestId: string, isSession: boolean) => Promise<T>
): Promise<T> {
  if (req.sessionId) {
    const { getOrCreate } = await import('../services/sessionStore')
    const { page, ctx } = await getOrCreate(req.sessionId, req.setCookies, req.proxy)
    return await fn(ctx, page, req.sessionId, true)
  }

  return withCtx(req.proxy, async (ctx, requestId) => {
    const page = await ctx.newPage()
    registerPage(requestId, page)
    return await fn(ctx, page, requestId, false)
  })
}

// Re-export registerPage so solvers can use it
export { registerPage }

// --- Page interaction helpers ---

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

export async function typeField(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: 10000 })
  await page.click(selector)
  await page.keyboard.press('Control+a')
  await sleep(50)
  await page.keyboard.type(value, { delay: 50 })
  const actual = await page.evaluate((sel) => {
    const el = document.querySelector<HTMLInputElement>(sel)
    return el?.value ?? ''
  }, selector)
  if (actual !== value) {
    await page.click(selector)
    await page.keyboard.press('Control+a')
    await page.keyboard.type(value, { delay: 80 })
  }
}

// --- Cookie helpers ---

export function toPwCookies(url: string, cookies: CookieParam[]): Array<{
  name: string; value: string; domain?: string; path?: string
  expires?: number; httpOnly?: boolean; secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}> {
  const domain = new URL(url).hostname
  return cookies.map(c => ({
    name: c.name, value: c.value,
    domain: c.domain ?? domain, path: c.path ?? '/',
    expires: c.expires, httpOnly: c.httpOnly,
    secure: c.secure, sameSite: c.sameSite,
  }))
}

export function fromPwCookies(cookies: Array<{
  name: string; value: string; domain: string; path: string
  expires: number; httpOnly: boolean; secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}>): CookieParam[] {
  return cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
  }))
}

// --- Utility ---

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function buildProxyUrl(proxy: ProxyConfig): string {
  const scheme = proxy.protocol ?? 'http'
  if (proxy.username && proxy.password) {
    return `${scheme}://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
  }
  return `${scheme}://${proxy.host}:${proxy.port}`
}