export type SolverMode =
  | 'auto'
  | 'cloudflare'
  | 'turnstile-min'
  | 'turnstile-max'
  | 'cf-cfbypass'
  | 'waf-session'
  | 'source'
  | 'hcaptcha'
  | 'recaptcha-v2'
  | 'recaptcha-v3'
  | 'aws-waf'

export interface ProxyConfig {
  host: string
  port: number
  username?: string
  password?: string
  protocol?: 'socks5' | 'socks4' | 'http' | 'https'
}

export interface CookieParam {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface InterceptRule {
  url: string
  type: 'json' | 'binary' | 'text'
}

export interface ActionItem {
  type:
    | 'click'
    | 'type'
    | 'scroll'
    | 'hover'
    | 'select'
    | 'keypress'
    | 'wait'
    | 'navigate'
    | 'waitForSelector'
    | 'waitForText'
    | 'waitForURL'
    | 'evaluate'
    | 'evaluateAndReturn'
    | 'screenshot'
  selector?: string
  value?: string
  key?: string
  url?: string
  text?: string
  script?: string
  name?: string
  x?: number
  y?: number
  ms?: number
  wait?: number
  timeout?: number
  fullPage?: boolean
}

export interface LoginConfig {
  loginUrl: string
  usernameSelector?: string
  passwordSelector?: string
  submitSelector?: string
  username?: string
  password?: string
  waitAfterLogin?: number
}

export interface WebhookConfig {
  url: string
  method?: 'POST' | 'GET' | 'PUT'
  headers?: Record<string, string>
}

export interface BypassRequest {
  url: string
  mode?: SolverMode
  siteKey?: string
  waitFor?: number
  getPageSource?: boolean
  login?: LoginConfig
  actions?: ActionItem[]
  setCookies?: CookieParam[]
  intercept?: InterceptRule[]
  proxy?: ProxyConfig
  useProxy?: boolean
  country?: string
  webhook?: WebhookConfig
  async?: boolean
  sessionId?: string
}

export interface BypassResult {
  token: string | null
  cf_cfbypass: string | null
  __cf_bm: string | null
  aws_waf_token: string | null
  cookies: CookieParam[]
  sessionCookies: Record<string, string>
  userAgent: string
  title: string
  source: string | null
  finalUrl: string
  intercepted: Record<string, unknown>
  returned: Record<string, unknown>
  solveMs: number
  proxy: string | null
  mode: SolverMode
}

export interface WafSessionResult {
  cookies: CookieParam[]
  headers: Record<string, string>
  proxy: string | null
  solveMs: number
}

export interface Job {
  status: 'pending' | 'done' | 'failed'
  result: unknown
  error: string | null
  createdAt: number
  mode?: SolverMode
  url?: string
}

export interface ProxyStat {
  total: number
  active: number
  banned: number
  lastRefresh: number | null
}

export interface SolveStat {
  total: number
  success: number
  failed: number
  avgMs: number
  byMode: Partial<Record<SolverMode, { total: number; success: number; avgMs: number }>>
}

export interface ProxyEntry {
  url: string
  host: string
  port: number
  protocol: string
  country: string
  uptime: number
  average_timeout: number
  score: number
  failures: number
  banned: boolean
}

export type SseSendFn = (event: string, data: unknown) => void
