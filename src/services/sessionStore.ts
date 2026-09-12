import { chromium, BrowserContext, Page } from 'patchright'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import type { CookieParam, ProxyConfig } from '../types'
import { toPwCookies } from '../solvers/base'

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '300000', 10) // 5 minutes hard TTL

interface SessionEntry {
  ctx: BrowserContext
  page: Page
  createdAt: number
  timer: NodeJS.Timeout
  tempDir: string
}

const sessions: Map<string, SessionEntry> = new Map()

const COMMON_FLAGS = [
  '--disable-save-password-bubble',
  '--disable-single-click-autofill',
  '--disable-autofill-keyboard-accessory-view',
  '--password-store=basic',
  '--disable-features=AutofillServerCommunication,AutofillEnableAccountWalletStorage,PasswordManager,PrivateNetworkAccessPermissionPrompt,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults',
  '--allow-insecure-localhost',
  '--no-default-browser-check',
  '--use-fake-ui-for-media-stream',
]

const PERMISSIONS = [
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-write',
]

const IS_LINUX = process.platform === 'linux'

export async function getOrCreate(
  sessionId: string,
  cookies?: CookieParam[],
  proxy?: ProxyConfig
): Promise<{ page: Page; ctx: BrowserContext }> {
  const existing = sessions.get(sessionId)

  if (existing) {
    if (!existing.page.isClosed()) {
      if (cookies?.length) {
        const url = existing.page.url() || 'about:blank'
        if (url !== 'about:blank') {
          await existing.ctx.addCookies(toPwCookies(url, cookies)).catch(() => { })
        }
      }
      return { page: existing.page, ctx: existing.ctx }
    }
    // Page was closed externally — cleanup and recreate
    await destroy(sessionId)
  }

  const tempDir = path.join(os.tmpdir(), `nexus-session-${sessionId}-${Date.now()}`)

  const launchOptions = IS_LINUX
    ? {
      channel: 'chrome' as const,
      headless: false,
      viewport: null as null,
      permissions: PERMISSIONS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-crash-reporter',
        ...COMMON_FLAGS,
      ],
      ...(proxy ? {
        proxy: {
          server: `${proxy.protocol ?? 'socks5'}://${proxy.host}:${proxy.port}`,
          ...(proxy.username ? { username: proxy.username } : {}),
          ...(proxy.password ? { password: proxy.password } : {}),
        }
      } : {})
    }
    : {
      channel: 'chrome' as const,
      headless: false,
      viewport: null as null,
      permissions: PERMISSIONS,
      args: [
        ...COMMON_FLAGS,
      ],
      ...(proxy ? {
        proxy: {
          server: `${proxy.protocol ?? 'socks5'}://${proxy.host}:${proxy.port}`,
          ...(proxy.username ? { username: proxy.username } : {}),
          ...(proxy.password ? { password: proxy.password } : {}),
        }
      } : {})
    }

  const ctx = await chromium.launchPersistentContext(tempDir, launchOptions)
  const page = ctx.pages()[0] ?? await ctx.newPage()

  page.on('dialog', dialog => dialog.accept().catch(() => { }))

  if (cookies?.length) {
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
    } catch (_) { }
  }

  // 5 minutes hard TTL: auto-destroy whether in use or not
  const timer = setTimeout(async () => {
    console.log(`[SessionStore] Session "${sessionId}" reached 5-minute TTL — auto-destroying...`)
    await destroy(sessionId).catch(() => { })
  }, SESSION_TTL_MS)

  sessions.set(sessionId, {
    ctx,
    page,
    createdAt: Date.now(),
    timer,
    tempDir,
  })

  console.log(`[SessionStore] Session "${sessionId}" created (auto-destroys in 5 mins)`)
  return { page, ctx }
}

export async function destroy(sessionId: string | 'all'): Promise<void> {
  if (sessionId === 'all') {
    const keys = [...sessions.keys()]
    await Promise.allSettled(keys.map(k => destroy(k)))
    return
  }

  const entry = sessions.get(sessionId)
  if (entry) {
    sessions.delete(sessionId)
    clearTimeout(entry.timer)
    await entry.ctx.close().catch(() => { })
    try {
      if (entry.tempDir && fs.existsSync(entry.tempDir)) {
        fs.rmSync(entry.tempDir, { recursive: true, force: true })
      }
    } catch (_) { }
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
