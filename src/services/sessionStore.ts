import { chromium, BrowserContext, Page } from 'patchright'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { execSync } from 'child_process'
import type { CookieParam, ProxyConfig } from '../types'
import { toPwCookies } from '../solvers/base'
import { LAUNCH_OPTIONS } from '../pool/browserPool'
import { HEADLESS } from '../constants'

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '300000', 10)
const IS_LINUX = process.platform === 'linux'

interface SessionEntry {
  ctx: BrowserContext
  page: Page
  createdAt: number
  timer: NodeJS.Timeout
  tempDir: string
}

const sessions: Map<string, SessionEntry> = new Map()

export async function getOrCreate(sessionId: string, cookies?: CookieParam[], proxy?: ProxyConfig): Promise<{ page: Page; ctx: BrowserContext }> {
  const existing = sessions.get(sessionId)
  if (existing) {
    if (!existing.page.isClosed()) {
      if (cookies?.length) {
        const url = existing.page.url() || 'about:blank'
        if (url !== 'about:blank') await existing.ctx.addCookies(toPwCookies(url, cookies)).catch(() => { })
      }
      return { page: existing.page, ctx: existing.ctx }
    }
    await destroy(sessionId)
  }

  const tempDir = path.join(os.tmpdir(), `nexus-session-${sessionId}-${Date.now()}`)
  const ctx = await chromium.launchPersistentContext(tempDir, {
    ...LAUNCH_OPTIONS,
    headless: HEADLESS,
    ...(proxy ? {
      proxy: {
        server: `${proxy.protocol ?? 'socks5'}://${proxy.host}:${proxy.port}`,
        ...(proxy.username ? { username: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {}),
      }
    } : {})
  })

  if (IS_LINUX) {
    await new Promise(r => setTimeout(r, 2000))
    const display = process.env.DISPLAY || ':99'
    const allWindows = execSync(`DISPLAY=${display} xdotool search --class "chrome"`).toString().trim().split('\n')
      ; (ctx as any)._windowId = allWindows[allWindows.length - 1]
    console.log(`[SessionStore] Captured window ID: ${(ctx as any)._windowId}`)
  }

  const page = ctx.pages()[0] ?? await ctx.newPage()
  page.on('dialog', dialog => dialog.accept().catch(() => { }))

  if (cookies?.length) {
    await ctx.addCookies(cookies.map(c => ({
      name: c.name, value: c.value,
      domain: c.domain ?? '.localhost', path: c.path ?? '/',
      expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
    }))).catch(() => { })
  }

  const timer = setTimeout(async () => {
    console.log(`[SessionStore] Session "${sessionId}" reached TTL — auto-destroying...`)
    await destroy(sessionId).catch(() => { })
  }, SESSION_TTL_MS)

  sessions.set(sessionId, { ctx, page, createdAt: Date.now(), timer, tempDir })
  console.log(`[SessionStore] Session "${sessionId}" created (auto-destroys in ${SESSION_TTL_MS / 60000} mins)`)
  return { page, ctx }
}

export async function destroy(sessionId: string | 'all'): Promise<void> {
  if (sessionId === 'all') { await Promise.allSettled([...sessions.keys()].map(k => destroy(k))); return }
  const entry = sessions.get(sessionId)
  if (entry) {
    sessions.delete(sessionId)
    clearTimeout(entry.timer)
    await entry.ctx.close().catch(() => { })
    if (entry.tempDir && fs.existsSync(entry.tempDir)) fs.rmSync(entry.tempDir, { recursive: true, force: true })
    console.log(`[SessionStore] Session "${sessionId}" destroyed`)
  }
}

export function list(): Array<{ sessionId: string; ageSeconds: number; ttlRemainingSeconds: number }> {
  const now = Date.now()
  return [...sessions.entries()].map(([id, entry]) => ({
    sessionId: id,
    ageSeconds: Math.round((now - entry.createdAt) / 1000),
    ttlRemainingSeconds: Math.max(0, Math.round((SESSION_TTL_MS - (now - entry.createdAt)) / 1000)),
  }))
}