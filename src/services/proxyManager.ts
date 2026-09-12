import axios from 'axios'
import {
  PROXYSCRAPE_URL,
  PROXY_REFRESH_INTERVAL_MS,
  PROXY_BAN_THRESHOLD,
  PROXY_MIN_UPTIME,
  PROXY_MAX_TIMEOUT,
  BLACKLISTED_PORTS,
  PROXY_COUNTRIES,
  PROXY_SCORE_MAX,
  DISCRIMINATOR_URLS,
} from '../constants'
import { getAxiosHeaders } from '../headers/chrome128'
import type { ProxyConfig, ProxyStat, ProxyEntry } from '../types'
import { SocksProxyAgent } from 'socks-proxy-agent'

let pool: Map<string, ProxyEntry> = new Map()
let lastRefresh: number | null = null
let refreshTimer: NodeJS.Timeout | null = null

// ─── Parsing ────────────────────────────────────────────────────────────────

export function parseUrl(url: string): ProxyConfig | null {
  try {
    const u = new URL(url)
    return {
      protocol: (u.protocol.replace(':', '') as ProxyConfig['protocol']) ?? 'http',
      host: u.hostname,
      port: parseInt(u.port, 10),
      username: u.username || undefined,
      password: u.password || undefined,
    }
  } catch {
    return null
  }
}

export function buildUrl(config: ProxyConfig): string {
  const scheme = config.protocol ?? 'http'
  if (config.username && config.password) {
    return `${scheme}://${config.username}:${config.password}@${config.host}:${config.port}`
  }
  return `${scheme}://${config.host}:${config.port}`
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

export async function refresh(): Promise<void> {
  try {
    const res = await axios.get(PROXYSCRAPE_URL, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })

    const raw: Array<{
      ip: string
      port: number
      protocol: string
      ip_data: { countryCode: string }
      anonymity: string
      uptime: number
      timeout: number
      alive: boolean
    }> = res.data?.proxies ?? res.data ?? []

    const filtered = raw.filter(p => {
      if (!p.alive) return false
      if (!PROXY_COUNTRIES.includes(p.ip_data?.countryCode?.toUpperCase())) return false
      if (p.anonymity?.toLowerCase() !== 'elite') return false
      if ((p.uptime ?? 0) < PROXY_MIN_UPTIME) return false
      if ((p.timeout ?? 9999) > PROXY_MAX_TIMEOUT) return false
      if (BLACKLISTED_PORTS.has(p.port)) return false
      return true
    })

    for (const p of filtered) {
      const protocol = (p.protocol ?? 'http').toLowerCase()
      const url = `${protocol}://${p.ip}:${p.port}`

      if (!pool.has(url)) {
        pool.set(url, {
          url,
          host: p.ip,
          port: p.port,
          protocol,
          country: p.ip_data?.countryCode?.toUpperCase() ?? 'XX',
          uptime: p.uptime ?? 0,
          average_timeout: p.timeout ?? 9999,
          score: 3,
          failures: 0,
          banned: false,
        })
      }
    }

    lastRefresh = Date.now()
    console.log(`[ProxyManager] Refreshed — pool size: ${pool.size}`)
  } catch (err) {
    console.error('[ProxyManager] Refresh failed:', err)
  }
}

// ─── Selection ───────────────────────────────────────────────────────────────

export function next(country?: string): ProxyConfig | null {
  const candidates = [...pool.values()].filter(p => {
    if (p.banned) return false
    if (country && p.country !== country.toUpperCase()) return false
    return true
  })

  if (!candidates.length) return null

  // Sort by score descending, round-robin within same tier
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates[0]

  return {
    protocol: top.protocol as ProxyConfig['protocol'],
    host: top.host,
    port: top.port,
  }
}

export function getOne(country?: string): (ProxyEntry & { proxy: string }) | null {
  const candidates = [...pool.values()].filter(p => {
    if (p.banned) return false
    if (country && p.country !== country.toUpperCase()) return false
    return true
  })
  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates[0]
  return { ...top, proxy: top.url }
}

// ─── Scoring & Banning ───────────────────────────────────────────────────────

export function ban(proxyUrl: string): void {
  const entry = pool.get(proxyUrl)
  if (!entry) return
  entry.failures++
  if (entry.failures >= PROXY_BAN_THRESHOLD) {
    entry.banned = true
    console.log(`[ProxyManager] Banned: ${proxyUrl}`)
  }
}

export function score(proxyUrl: string, points: number): void {
  const entry = pool.get(proxyUrl)
  if (!entry) return
  entry.score = Math.max(0, Math.min(PROXY_SCORE_MAX, entry.score + points))
  if (entry.score === 0) entry.banned = true
}

// ─── Live validation ──────────────────────────────────────────────────────────

export async function validateAndScore(proxyUrl: string): Promise<ProxyEntry | null> {
  const entry = pool.get(proxyUrl)
  if (!entry) return null

  let passed = 0
  for (const testUrl of DISCRIMINATOR_URLS) {
    try {
      const isSocks = entry.protocol.startsWith('socks')
      const agentOrProxy = isSocks
        ? { httpsAgent: new SocksProxyAgent(proxyUrl) }
        : { proxy: { host: entry.host, port: entry.port } }

      await axios.get(testUrl, {
        ...agentOrProxy,
        timeout: 5000,
        headers: getAxiosHeaders(),
        maxRedirects: 3,
      })
      passed++
    } catch { /* proxy failed this target */ }
  }

  const newScore = Math.min(PROXY_SCORE_MAX, Math.max(0, passed + Math.floor(entry.score / 2)))
  entry.score = newScore
  if (newScore === 0) entry.banned = true

  return entry
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export function getStats(): ProxyStat {
  const all = [...pool.values()]
  return {
    total: all.length,
    active: all.filter(p => !p.banned).length,
    banned: all.filter(p => p.banned).length,
    lastRefresh,
  }
}

export function getCountryBreakdown(): Record<string, number> {
  const breakdown: Record<string, number> = {}
  for (const p of pool.values()) {
    if (!p.banned) {
      breakdown[p.country] = (breakdown[p.country] ?? 0) + 1
    }
  }
  return breakdown
}

// ─── Init ────────────────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  await refresh()  // await instead of fire-and-forget
  refreshTimer = setInterval(
    () => refresh().catch(err => console.error('[ProxyManager] Refresh error:', err)),
    PROXY_REFRESH_INTERVAL_MS
  )
  refreshTimer.unref()
}

export function stop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}
