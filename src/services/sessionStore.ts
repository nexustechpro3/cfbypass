import { BrowserContext, Page } from 'patchright'
import { getBrowser } from '../pool/browserPool'
import { setupPage, toPwCookies } from '../solvers/base'
import type { CookieParam } from '../types'

interface SessionEntry {
  ctx: BrowserContext
  page: Page
}

const sessions: Map<string, SessionEntry> = new Map()

export async function getOrCreate(sessionId: string, cookies?: CookieParam[]): Promise<Page> {
  const existing = sessions.get(sessionId)

  if (existing) {
    // If page is still alive, reuse it
    if (!existing.page.isClosed()) {
      if (cookies?.length) {
        const url = existing.page.url() || 'about:blank'
        if (url !== 'about:blank') {
          await existing.ctx.addCookies(toPwCookies(url, cookies))
        }
      }
      return existing.page
    }
    // Page is closed — destroy and recreate
    existing.ctx.close().catch(() => { /* ignore */ })
    sessions.delete(sessionId)
  }

  // Create fresh context + page
  const browser = getBrowser()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await setupPage(page)

  if (cookies?.length) {
    // Need at least a domain — use a placeholder
    try {
      await ctx.addCookies(cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? '.localhost',
        path: c.path ?? '/',
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })))
    } catch (_) { /* ignore invalid cookies */ }
  }

  sessions.set(sessionId, { ctx, page })
  return page
}

export async function destroy(sessionId: string | 'all'): Promise<void> {
  if (sessionId === 'all') {
    const entries = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(entries.map(e => e.ctx.close()))
    return
  }

  const entry = sessions.get(sessionId)
  if (entry) {
    sessions.delete(sessionId)
    await entry.ctx.close().catch(() => { /* ignore */ })
  }
}

export function list(): string[] {
  return [...sessions.keys()]
}
