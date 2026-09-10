import type { SolverMode } from './types'

export const SOLVER_MODES: SolverMode[] = [
  'auto',
  'cloudflare',
  'turnstile-min',
  'turnstile-max',
  'cf-clearance',
  'waf-session',
  'source',
  'hcaptcha',
  'recaptcha-v2',
  'recaptcha-v3',
  'aws-waf',
]

// Headers stripped from waf-session response — not useful for replay
export const STRIP_HEADERS = new Set([
  'content-type',
  'accept-encoding',
  'accept',
  'content-length',
  'transfer-encoding',
  'host',
])

// Proxy pre-filter — blacklisted ports (all :9898 proxies consistently fail)
export const BLACKLISTED_PORTS = new Set([9898])

// Proxy source countries — Asian DCs outperform Western DCs against CF
export const PROXY_COUNTRIES = ['HK', 'KH', 'TW', 'KR', 'VN']

// Discriminator targets for proxy scoring — must pass all 3 for score 5/5
export const DISCRIMINATOR_URLS = [
  'https://www.nike.com',
  'https://www.amazon.com',
  'https://steamcommunity.com',
]

// ProxyScrape API v4 — metadata-rich, pre-filterable
export const PROXYSCRAPE_URL =
  'https://api.proxyscrape.com/v4/free-proxy-list/get' +
  '?request=display_proxies&proxy_format=protocolipport&format=json' +
  `&country=${PROXY_COUNTRIES.join(',')}&anonymity=elite&timeout=2000`

export const PROXY_REFRESH_INTERVAL_MS = 5 * 60 * 1000   // 5 minutes
export const PROXY_BAN_THRESHOLD = 3                       // failures before ban
export const PROXY_MIN_UPTIME = 80                         // %
export const PROXY_MAX_TIMEOUT = 2000                      // ms
export const PROXY_SCORE_MAX = 5

export const JOB_TTL_MS = 5 * 60 * 1000                   // 5 minutes
export const SSE_PING_INTERVAL_MS = 25000
export const SSE_STATS_INTERVAL_MS = 3000
export const MAX_WAIT_FOR_MS = 10000
export const CF_POLL_INTERVAL_MS = 800
export const CLEARANCE_POLL_INTERVAL_MS = 1000
export const TOKEN_POLL_INTERVAL_MS = 400
