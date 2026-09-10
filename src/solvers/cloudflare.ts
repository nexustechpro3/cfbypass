import { Page, Response } from 'patchright'
import type { BypassRequest, BypassResult, InterceptRule, CookieParam } from '../types'
import { runActions } from '../actions/runner'
import {
  withCtx,
  setupPage,
  waitForcfbypass,
  waitForCF,
  waitForToken,
  toPwCookies,
  fromPwCookies,
  sleep,
  buildProxyUrl,
} from './base'
import { STRIP_HEADERS } from '../constants'

export async function bypassCloudflare(req: BypassRequest): Promise<BypassResult> {
  const start = Date.now()
  const mode = req.mode ?? 'cloudflare'

  return withCtx(req.proxy, async ctx => {
    const page = await ctx.newPage()
    await setupPage(page)

    const intercepted: Record<string, unknown> = {}
    const returned: Record<string, unknown> = {}

    // Set cookies before navigation
    if (req.setCookies?.length) {
      await ctx.addCookies(toPwCookies(req.url, req.setCookies))
    }

    // Register response interceptors
    if (req.intercept?.length) {
      page.on('response', async (response: Response) => {
        for (const rule of req.intercept!) {
          if (response.url().includes(rule.url)) {
            try {
              if (rule.type === 'json') {
                intercepted[rule.url] = await response.json().catch(() => null)
              } else if (rule.type === 'text') {
                intercepted[rule.url] = await response.text().catch(() => null)
              } else {
                const buf = await response.body().catch(() => null)
                intercepted[rule.url] = buf ? buf.toString('base64') : null
              }
            } catch (_) { /* ignore intercept errors */ }
          }
        }
      })
    }

    // Login flow
    if (req.login) {
      const { loginUrl, usernameSelector, passwordSelector, submitSelector, username, password, waitAfterLogin } = req.login
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
      await waitForCF(page)
      if (usernameSelector && username) {
        await page.waitForSelector(usernameSelector, { timeout: 10000 })
        await page.fill(usernameSelector, username)
      }
      if (passwordSelector && password) {
        await page.waitForSelector(passwordSelector, { timeout: 10000 })
        await page.fill(passwordSelector, password)
      }
      if (submitSelector) {
        await page.click(submitSelector)
      }
      if (waitAfterLogin) await sleep(waitAfterLogin)
    }

    // Navigate to target
    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })

    // Poll for cf_cfbypass — definitive solved signal
    let cfcfbypass = await waitForcfbypass(page)

    // Fallback: text check (some CF configs don't issue the cookie)
    if (!cfcfbypass) {
      const cleared = await waitForCF(page, 30000)
      if (cleared) {
        const cookies = await ctx.cookies()
        const ck = cookies.find(c => c.name === 'cf_cfbypass')
        cfcfbypass = ck?.value ?? null
      }
    }

    // Wait for network to settle
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { /* ok */ })

    // Extra wait
    if (req.waitFor) {
      await sleep(Math.min(req.waitFor, 10000))
    }

    // Run custom actions pipeline
    if (req.actions?.length) {
      await runActions(page, req.actions, returned)
    }

    // Collect results
    const allCookies = await ctx.cookies()
    const cfCookies = fromPwCookies(allCookies as Parameters<typeof fromPwCookies>[0])
    const sessionCookies: Record<string, string> = {}
    for (const c of allCookies) sessionCookies[c.name] = c.value

    const userAgent = await page.evaluate(() => navigator.userAgent)
    const title = await page.title().catch(() => '')
    const finalUrl = page.url()
    const source = req.getPageSource ? await page.content().catch(() => null) : null

    // Try to find Turnstile token
    let token: string | null = null
    if (req.siteKey || mode === 'turnstile-max') {
      token = await waitForToken(page, 5000)
    }

    // Extract named cookies
    const cfBm = allCookies.find(c => c.name === '__cf_bm')?.value ?? null
    const awsWafToken = allCookies.find(c => c.name === 'aws-waf-token')?.value ?? null

    return {
      token,
      cf_cfbypass: cfcfbypass,
      __cf_bm: cfBm,
      aws_waf_token: awsWafToken,
      cookies: cfCookies,
      sessionCookies,
      userAgent,
      title,
      source,
      finalUrl,
      intercepted,
      returned,
      solveMs: Date.now() - start,
      proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
      mode,
    }
  })
}
