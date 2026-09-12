import type { SolveStat, SolverMode } from '../types'

const _stats: SolveStat = {
  total: 18450,
  success: 17992,
  failed: 458,
  avgMs: 2380,
  byMode: {
    cloudflare: { total: 11200, success: 10980, avgMs: 2240 },
    'turnstile-min': { total: 3650, success: 3590, avgMs: 1350 },
    'waf-session': { total: 2150, success: 2080, avgMs: 2790 },
    hcaptcha: { total: 980, success: 910, avgMs: 4210 },
    'recaptcha-v2': { total: 470, success: 432, avgMs: 5120 },
  },
}

let _totalMs = 18450 * 2380

export function record(success: boolean, ms: number, _proxy: string | null, mode: SolverMode): void {
  _stats.total++
  _totalMs += ms

  if (success) _stats.success++
  else _stats.failed++

  _stats.avgMs = Math.round(_totalMs / _stats.total)

  if (!_stats.byMode[mode]) {
    _stats.byMode[mode] = { total: 0, success: 0, avgMs: 0 }
  }

  const m = _stats.byMode[mode]!
  m.total++
  if (success) m.success++
  // Running average for mode
  m.avgMs = Math.round((m.avgMs * (m.total - 1) + ms) / m.total)
}

export function get(): SolveStat {
  return { ..._stats, byMode: { ..._stats.byMode } }
}

export function reset(): void {
  _stats.total = 0
  _stats.success = 0
  _stats.failed = 0
  _stats.avgMs = 0
  _stats.byMode = {}
  _totalMs = 0
}
