import { Page } from 'patchright'
import { withCtx, setupPage, sleep } from '../solvers/base'
import type { ProxyConfig, SolverMode } from '../types'

// ─── Detection result ─────────────────────────────────────────────────────────

export interface DetectionResult {
  /** The single best solver mode to use */
  mode: SolverMode
  /** All challenges found on the page — there may be more than one */
  challenges: ChallengeType[]
  /** Whether Cloudflare is wrapping the page (JS challenge, 5s shield, managed) */
  hasCloudflare: boolean
  /** Specific CF challenge type if detected */
  cfChallengeType: 'js' | 'managed' | 'interactive' | 'turnstile' | null
  /** Turnstile site key if found in page source */
  turnstileSiteKey: string | null
  /** reCAPTCHA site key if found */
  recaptchaSiteKey: string | null
  /** hCaptcha site key if found */
  hcaptchaSiteKey: string | null
  /** Whether AWS WAF is present */
  hasAwsWaf: boolean
  /** Page title at detection time */
  title: string
  /** Final URL after redirects */
  finalUrl: string
  /** HTTP status code of the response */
  status: number
  /** How long detection took in ms */
  detectMs: number
  /** Raw signals that fired — useful for debugging */
  signals: string[]
}

export type ChallengeType =
  | 'cf-js-challenge'
  | 'cf-managed-challenge'
  | 'cf-interactive-challenge'
  | 'cf-turnstile'
  | 'recaptcha-v2'
  | 'recaptcha-v3'
  | 'hcaptcha'
  | 'aws-waf'
  | 'none'

// ─── Signal definitions ───────────────────────────────────────────────────────

// Page title patterns that indicate a CF challenge page
const CF_TITLE_PATTERNS = [
  'just a moment',
  'checking your browser',
  'ddos-guard',
  'please wait',
  'verifying you are human',
  'security check',
  'attention required',
  'one moment, please',
]

// CF challenge page body text markers
const CF_BODY_PATTERNS = [
  'challenges.cloudflare.com',
  'cf-challenge-running',
  '__cf_chl_f_tk',
  'cf-spinner',
  'cf_captcha_kind',
  'cfl.re',
  'cloudflare ray id',
]

// CF managed/interactive challenge markers
const CF_MANAGED_PATTERNS = [
  'cf-turnstile',
  'data-sitekey',
  '/cdn-cgi/challenge-platform',
  'cf-chl-widget',
  '__cf_chl_rt_tk',
  'chl_opt',
  '__cf_chl_opt',
]

// Turnstile-specific markers
const TURNSTILE_SCRIPT_PATTERNS = [
  'challenges.cloudflare.com/turnstile',
  '/turnstile/v0/api.js',
]

// reCAPTCHA markers
const RECAPTCHA_PATTERNS = [
  'google.com/recaptcha',
  'gstatic.com/recaptcha',
  'grecaptcha',
  'g-recaptcha',
]

// hCaptcha markers
const HCAPTCHA_PATTERNS = [
  'hcaptcha.com',
  'js.hcaptcha.com',
  'h-captcha',
  'data-hcaptcha-sitekey',
]

// AWS WAF markers
const AWS_WAF_PATTERNS = [
  'aws-waf-token',
  'awswaf',
  'aws.amazon.com/waf',
  'captcha.awswaf.aws',
  'AWSManagedRulesATPRuleSet',
]

// ─── Extractor helpers ────────────────────────────────────────────────────────

interface PageSnapshot {
  title: string
  url: string
  bodyText: string
  bodyHtml: string
  scriptSrcs: string[]
  iframeSrcs: string[]
  metaRobots: string
  status: number
  responseHeaders: Record<string, string>
  // Dynamic window properties set by CF/captcha scripts
  hasCfChlOpt: boolean
  hasCfRayHeader: boolean
  hasGrecaptcha: boolean
  hasTurnstile: boolean
  hasHcaptcha: boolean
  hasAwsWafCaptcha: boolean
}

async function snapshotPage(page: Page): Promise<PageSnapshot> {
  // Wait briefly for initial scripts to execute
  await sleep(1500)

  const snapshot = await page.evaluate((): Omit<PageSnapshot, 'status' | 'responseHeaders' | 'hasCfRayHeader'> => {
    const bodyText = (document.body?.innerText ?? '').toLowerCase()
    const bodyHtml = document.documentElement?.outerHTML ?? ''
    const htmlLower = bodyHtml.toLowerCase()

    const scriptSrcs = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
      .map(s => s.src)

    const iframeSrcs = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[src]'))
      .map(f => f.src)

    const metaRobots = document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content ?? ''

    const w = window as unknown as {
      __cf_chl_opt?: unknown
      grecaptcha?: unknown
      turnstile?: unknown
      hcaptcha?: unknown
      AwsWafIntegration?: unknown
    }

    return {
      title: document.title,
      url: window.location.href,
      bodyText,
      bodyHtml,
      scriptSrcs,
      iframeSrcs,
      metaRobots,
      hasCfChlOpt: typeof w.__cf_chl_opt !== 'undefined',
      hasGrecaptcha: typeof w.grecaptcha !== 'undefined',
      hasTurnstile: typeof w.turnstile !== 'undefined',
      hasHcaptcha: typeof w.hcaptcha !== 'undefined',
      hasAwsWafCaptcha: typeof w.AwsWafIntegration !== 'undefined',
    }
  }).catch(() => ({
    title: '',
    url: page.url(),
    bodyText: '',
    bodyHtml: '',
    scriptSrcs: [],
    iframeSrcs: [],
    metaRobots: '',
    hasCfChlOpt: false,
    hasGrecaptcha: false,
    hasTurnstile: false,
    hasHcaptcha: false,
    hasAwsWafCaptcha: false,
  }))

  return {
    ...snapshot,
    status: 200, // filled by caller from response event
    responseHeaders: {}, // filled by caller
    hasCfRayHeader: false, // filled by caller
  }
}

// ─── Sitekey extractors ───────────────────────────────────────────────────────

function extractTurnstileSiteKey(html: string): string | null {
  // <div class="cf-turnstile" data-sitekey="0x4AAAA...">
  const m = html.match(/class=["'][^"']*cf-turnstile[^"']*["'][^>]*data-sitekey=["']([^"']+)["']/)
    ?? html.match(/data-sitekey=["']([^"']+)["'][^>]*class=["'][^"']*cf-turnstile/)
    ?? html.match(/turnstile[^>]*data-sitekey=["']([^"']+)["']/)
    // window.turnstile.render() inline call
    ?? html.match(/turnstile\.render\([^,)]*,\s*\{[^}]*sitekey:\s*["']([^"']+)["']/)
    // turnstile api.js script with data-sitekey on any element
    ?? html.match(/challenges\.cloudflare\.com\/turnstile[^"']*["'][^>]*>[\s\S]*?data-sitekey=["']([^"']+)["']/)
  return m?.[1] ?? null
}

function extractRecaptchaSiteKey(html: string): string | null {
  const m = html.match(/class=["'][^"']*g-recaptcha[^"']*["'][^>]*data-sitekey=["']([^"']+)["']/)
    ?? html.match(/data-sitekey=["']([^"']+)["'][^>]*class=["'][^"']*g-recaptcha/)
    ?? html.match(/grecaptcha\.execute\(["']([^"']+)["']/)
    ?? html.match(/grecaptcha\.render\([^,)]*,\s*\{[^}]*sitekey:\s*["']([^"']+)["']/)
    ?? html.match(/data-sitekey=["']([6][^"']{38})["']/) // reCAPTCHA keys always start with 6
  return m?.[1] ?? null
}

function extractHcaptchaSiteKey(html: string): string | null {
  const m = html.match(/class=["'][^"']*h-captcha[^"']*["'][^>]*data-sitekey=["']([^"']+)["']/)
    ?? html.match(/data-sitekey=["']([^"']+)["'][^>]*class=["'][^"']*h-captcha/)
    ?? html.match(/data-hcaptcha-sitekey=["']([^"']+)["']/)
    ?? html.match(/hcaptcha\.render\([^,)]*,\s*\{[^}]*sitekey:\s*["']([^"']+)["']/)
  return m?.[1] ?? null
}

// ─── Recaptcha version sniffer ────────────────────────────────────────────────

function detectRecaptchaVersion(html: string, scriptSrcs: string[]): 'recaptcha-v2' | 'recaptcha-v3' | null {
  const allSrcs = scriptSrcs.join(' ')

  // v3 API endpoint is /api.js?render= with a sitekey, v2 uses /api.js alone or with explicit v2
  const hasV3Render = /google\.com\/recaptcha\/api\.js\?render=/.test(allSrcs + html)
  const hasV3Badge = /grecaptcha-badge/.test(html) // v3 floats the badge
  const hasV3Execute = /grecaptcha\.execute/.test(html)
  const hasV2Checkbox = /g-recaptcha(?!.*v3)/.test(html) && /<div[^>]*g-recaptcha/.test(html)
  const hasV2Audio = /rc-audiochallenge|recaptcha-audio/.test(html)
  const hasV2Iframe = scriptSrcs.some(s => s.includes('recaptcha/api2/bframe') || s.includes('recaptcha/api2/anchor'))

  if (hasV3Render || hasV3Execute || (hasV3Badge && !hasV2Checkbox)) return 'recaptcha-v3'
  if (hasV2Checkbox || hasV2Audio || hasV2Iframe) return 'recaptcha-v2'

  // Fallback: if grecaptcha is present without clear v3 signals, assume v2
  if (/grecaptcha/.test(html)) return 'recaptcha-v2'
  return null
}

// ─── Main detector ────────────────────────────────────────────────────────────

export async function detect(url: string, proxy?: ProxyConfig): Promise<DetectionResult> {
  const start = Date.now()

  return withCtx(proxy, async ctx => {
    const page = await ctx.newPage()
    await setupPage(page)

    let responseStatus = 200
    const responseHeaders: Record<string, string> = {}
    let hasCfRayHeader = false

    // Capture the main response headers
    page.on('response', response => {
      const resUrl = response.url()
      if (resUrl === url || resUrl === url + '/' || resUrl.startsWith(url)) {
        responseStatus = response.status()
        const headers = response.headers()
        Object.assign(responseHeaders, headers)
        if (headers['cf-ray'] || headers['cf-cache-status'] || headers['cf-request-id']) {
          hasCfRayHeader = true
        }
      }
    })

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (_) {
      // Navigation errors are fine — we still get a page to inspect
    }

    const snap = await snapshotPage(page)
    snap.status = responseStatus
    snap.responseHeaders = responseHeaders
    snap.hasCfRayHeader = hasCfRayHeader

    // ── Signal collection ─────────────────────────────────────────────────────

    const signals: string[] = []
    const challenges: ChallengeType[] = []
    const titleLower = snap.title.toLowerCase()
    const htmlLower = snap.bodyHtml.toLowerCase()
    const allText = titleLower + ' ' + snap.bodyText
    const allScripts = snap.scriptSrcs.join(' ').toLowerCase()
    const allIframes = snap.iframeSrcs.join(' ').toLowerCase()

    let hasCloudflare = false
    let cfChallengeType: DetectionResult['cfChallengeType'] = null
    let turnstileSiteKey: string | null = null
    let recaptchaSiteKey: string | null = null
    let hcaptchaSiteKey: string | null = null
    let hasAwsWaf = false

    // ── 1. Cloudflare JS challenge (title-based 5s shield) ────────────────────
    const cfTitleHit = CF_TITLE_PATTERNS.some(p => titleLower.includes(p))
    if (cfTitleHit) {
      signals.push(`cf-title: "${snap.title}"`)
      hasCloudflare = true
      cfChallengeType = 'js'
    }

    // ── 2. CF response headers (definitive CF signal) ─────────────────────────
    if (snap.hasCfRayHeader) {
      signals.push('cf-ray-header')
      hasCloudflare = true
    }

    // ── 3. CF body markers ────────────────────────────────────────────────────
    const cfBodyHit = CF_BODY_PATTERNS.filter(p => htmlLower.includes(p.toLowerCase()))
    if (cfBodyHit.length) {
      cfBodyHit.forEach(p => signals.push(`cf-body: ${p}`))
      hasCloudflare = true
      if (!cfChallengeType) cfChallengeType = 'js'
    }

    // ── 4. CF managed/interactive challenge markers ───────────────────────────
    const cfManagedHit = CF_MANAGED_PATTERNS.filter(p => htmlLower.includes(p.toLowerCase()))
    if (cfManagedHit.length) {
      cfManagedHit.forEach(p => signals.push(`cf-managed: ${p}`))
      hasCloudflare = true
      cfChallengeType = 'managed'
    }

    // ── 5. window.__cf_chl_opt — the most definitive CF challenge signal ──────
    if (snap.hasCfChlOpt) {
      signals.push('window.__cf_chl_opt')
      hasCloudflare = true
      cfChallengeType = 'interactive'
    }

    // ── 6. Turnstile widget ───────────────────────────────────────────────────
    const hasTurnstileScript = TURNSTILE_SCRIPT_PATTERNS.some(p => allScripts.includes(p.toLowerCase()))
    const hasTurnstileDiv = htmlLower.includes('cf-turnstile')
    const hasTurnstileWindow = snap.hasTurnstile

    if (hasTurnstileScript || hasTurnstileDiv || hasTurnstileWindow) {
      signals.push('turnstile-widget')
      hasCloudflare = true
      cfChallengeType = 'turnstile'
      challenges.push('cf-turnstile')
      turnstileSiteKey = extractTurnstileSiteKey(snap.bodyHtml)
      if (turnstileSiteKey) signals.push(`turnstile-sitekey: ${turnstileSiteKey}`)
    }

    // ── 7. reCAPTCHA ─────────────────────────────────────────────────────────
    const hasRecaptchaScript = RECAPTCHA_PATTERNS.some(p =>
      allScripts.includes(p.toLowerCase()) || htmlLower.includes(p.toLowerCase())
    )
    const hasRecaptchaIframe = RECAPTCHA_PATTERNS.some(p => allIframes.includes(p.toLowerCase()))

    if (hasRecaptchaScript || hasRecaptchaIframe || snap.hasGrecaptcha) {
      const rcVersion = detectRecaptchaVersion(snap.bodyHtml, snap.scriptSrcs)
      if (rcVersion) {
        signals.push(`recaptcha: ${rcVersion}`)
        challenges.push(rcVersion)
        recaptchaSiteKey = extractRecaptchaSiteKey(snap.bodyHtml)
        if (recaptchaSiteKey) signals.push(`recaptcha-sitekey: ${recaptchaSiteKey}`)
      }
    }

    // ── 8. hCaptcha ───────────────────────────────────────────────────────────
    const hasHcaptchaScript = HCAPTCHA_PATTERNS.some(p =>
      allScripts.includes(p.toLowerCase()) || htmlLower.includes(p.toLowerCase())
    )

    if (hasHcaptchaScript || snap.hasHcaptcha) {
      signals.push('hcaptcha')
      challenges.push('hcaptcha')
      hcaptchaSiteKey = extractHcaptchaSiteKey(snap.bodyHtml)
      if (hcaptchaSiteKey) signals.push(`hcaptcha-sitekey: ${hcaptchaSiteKey}`)
    }

    // ── 9. AWS WAF ────────────────────────────────────────────────────────────
    const hasAwsWafSignal = AWS_WAF_PATTERNS.some(p =>
      htmlLower.includes(p.toLowerCase()) || allScripts.includes(p.toLowerCase())
    )
    const hasAwsWafCookie = snap.hasAwsWafCaptcha

    if (hasAwsWafSignal || hasAwsWafCookie) {
      signals.push('aws-waf')
      challenges.push('aws-waf')
      hasAwsWaf = true
    }

    // ── 10. Add base CF challenge to challenges list ──────────────────────────
    if (hasCloudflare && cfChallengeType && !challenges.includes('cf-turnstile')) {
      switch (cfChallengeType) {
        case 'js': challenges.unshift('cf-js-challenge'); break
        case 'managed': challenges.unshift('cf-managed-challenge'); break
        case 'interactive': challenges.unshift('cf-interactive-challenge'); break
      }
    }

    // ── 11. Clean up — if nothing found ──────────────────────────────────────
    if (!challenges.length) challenges.push('none')

    // ── 12. Mode recommendation — priority order ──────────────────────────────
    // Priority: CF wrapping > Turnstile > hCaptcha > reCAPTCHA v2 > reCAPTCHA v3 > AWS WAF
    let mode: SolverMode = 'cloudflare' // safe default always works

    if (hasAwsWaf && !hasCloudflare) {
      mode = 'aws-waf'
    } else if (challenges.includes('hcaptcha') && !hasCloudflare) {
      mode = 'hcaptcha'
    } else if (challenges.includes('recaptcha-v2') && !hasCloudflare) {
      mode = 'recaptcha-v2'
    } else if (challenges.includes('recaptcha-v3') && !hasCloudflare) {
      mode = 'recaptcha-v3'
    } else if (hasCloudflare) {
      // Always use full cloudflare bypass when CF is wrapping the page
      // This handles CF + embedded Turnstile, CF JS challenge, CF managed challenge
      mode = 'cloudflare'
    } else if (challenges.includes('cf-turnstile') && !hasCloudflare) {
      // Standalone Turnstile widget on a non-CF page (rare)
      mode = turnstileSiteKey ? 'turnstile-min' : 'turnstile-max'
      // CF JS/managed challenge — full bypass
      mode = 'cloudflare'
    } else if (challenges[0] === 'none') {
      // No challenge detected — still use source to get the page
      mode = 'source'
    }

    return {
      mode,
      challenges,
      hasCloudflare,
      cfChallengeType,
      turnstileSiteKey,
      recaptchaSiteKey,
      hcaptchaSiteKey,
      hasAwsWaf,
      title: snap.title,
      finalUrl: page.url(),
      status: responseStatus,
      detectMs: Date.now() - start,
      signals,
    }
  })
}
