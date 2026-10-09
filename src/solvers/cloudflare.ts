import { Page, Response } from 'patchright'
import type { BypassRequest, BypassResult } from '../types'
import { runActions } from '../actions/runner'
import { withSessionOrCtx, waitForClearance, waitForCF, waitForToken, toPwCookies, fromPwCookies, sleep, buildProxyUrl, buildRequestProfile } from './base'

const IS_LINUX = process.platform === 'linux'

async function hasTurnstileIframe(page: Page): Promise<boolean> {
  return page.$('iframe[src*="challenges.cloudflare.com"]').then(el => !!el).catch(() => false)
}

async function clickTurnstileCheckbox(page: Page): Promise<boolean> {
  const t = global.timeOut
  try {
    await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: t })
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '')
    console.log(`[CF] Page text: ${pageText.replace(/\n/g, ' ')}`)
    const iframeEl = await page.$('iframe[src*="challenges.cloudflare.com"]')
    await iframeEl?.scrollIntoViewIfNeeded()
    const frame = await iframeEl?.contentFrame()
    if (!frame) { console.log('[CF] No contentFrame'); return false }
    await frame.waitForSelector('input[type="checkbox"]:not([disabled])', { timeout: t, state: 'visible' })
    for (let i = 0; i < 2; i++) {
      try {
        await frame.locator('input[type="checkbox"]').click()
        console.log(`[CF] Clicked via contentFrame (attempt ${i + 1})`)
        return true
      } catch {
        console.log(`[CF] contentFrame click attempt ${i + 1} failed`)
        // Wait for CF to re-enable the checkbox before retrying
        if (i === 0) await frame.waitForSelector('input[type="checkbox"]:not([disabled])', { timeout: t, state: 'visible' }).catch(() => sleep(6000))
      }
    }
    console.log('[CF] contentFrame exhausted, falling back to xdotool')
    const box = await page.locator('iframe[src*="challenges.cloudflare.com"]').boundingBox()
    if (!box) { console.log('[CF] No bounding box'); return false }
    const x = box.x + 30
    const y = box.y + box.height / 2
    await page.mouse.move(x, y, { steps: 10 })
    await sleep(150)
    await page.mouse.click(x, y)
    console.log(`[CF] Clicked via mouse at (${x.toFixed(0)}, ${y.toFixed(0)})`)
    return true
  } catch (err) {
    const msg = (err as Error).message
    // Frame detached = Patchright already solved and navigated — treat as success
    if (msg.includes('Frame was detached') || msg.includes('frame was detached')) {
      console.log('[CF] Frame detached — Patchright already solved, treating as success')
      return true
    }
    console.log('[CF] Checkbox click failed:', msg)
    return false
  }
}

async function attemptCFSolve(page: Page): Promise<string | null> {
  const t = global.timeOut
  const CF_TITLES = ['just a moment', 'checking your browser', 'verifying you are human', 'security check', 'please wait', 'attention required']
  const isCF = (title: string) => CF_TITLES.some(t => title.toLowerCase().includes(t))
  const getClearance = () => page.context().cookies().then(c => c.find(c => c.name === 'cf_clearance')?.value ?? null)
  for (let attempt = 0; attempt < 5; attempt++) {
    const title = await page.title().catch(() => '')
    const isChallenge = isCF(title)
    const hasWidget = await hasTurnstileIframe(page)
    console.log(`[CF] Attempt ${attempt + 1} — title: "${title}", isChallenge: ${isChallenge}, hasWidget: ${hasWidget}`)
    if (!isChallenge && !hasWidget) return getClearance()
    const html = await page.content().catch(() => '')
    const cType = html.match(/cType:\s*'([^']+)'/)?.[1] ?? 'unknown'
    console.log(`[CF] cType: ${cType}`)
    if (hasWidget || cType === 'managed' || cType === 'interactive' || isChallenge) {
      await clickTurnstileCheckbox(page)
      const cleared = await waitForClearance(page, t)
      if (cleared) return cleared
      const stillHasWidget = await hasTurnstileIframe(page)
      if (!isCF(await page.title().catch(() => '')) && !stillHasWidget) return getClearance()
    } else {
      await waitForCF(page, t)
      const clearance = await getClearance()
      if (clearance) return clearance
    }
    if (attempt < 4) await sleep(2000)
  }
  return getClearance()
}

export async function bypassCloudflare(req: BypassRequest): Promise<BypassResult> {
  const start = Date.now()
  const mode = req.mode ?? 'cloudflare'
  return withSessionOrCtx(req, async (ctx, page, requestId, isSession) => {
    const intercepted: Record<string, unknown> = {}
    const returned: Record<string, unknown> = {}
    if (req.setCookies?.length) await ctx.addCookies(toPwCookies(req.url, req.setCookies))
    if (req.intercept?.length) {
      page.on('response', async (response: Response) => {
        for (const rule of req.intercept!) {
          if (!response.url().includes(rule.url)) continue
          try {
            if (rule.type === 'json') intercepted[rule.url] = await response.json().catch(() => null)
            else if (rule.type === 'text') intercepted[rule.url] = await response.text().catch(() => null)
            else { const buf = await response.body().catch(() => null); intercepted[rule.url] = buf ? buf.toString('base64') : null }
          } catch { }
        }
      })
    }
    if (req.login) {
      const { loginUrl, usernameSelector, passwordSelector, submitSelector, username, password, waitAfterLogin } = req.login
      await page.goto(loginUrl, { waitUntil: 'load', timeout: global.timeOut })
      await sleep(2000)
      await attemptCFSolve(page)
      if (usernameSelector && username) { await page.waitForSelector(usernameSelector, { timeout: global.timeOut }); await page.fill(usernameSelector, username) }
      if (passwordSelector && password) { await page.waitForSelector(passwordSelector, { timeout: global.timeOut }); await page.fill(passwordSelector, password) }
      await attemptCFSolve(page)
      if (submitSelector) await page.click(submitSelector)
      if (waitAfterLogin) await sleep(waitAfterLogin)
    }
    const currentUrl = page.url()
    let cfClearance: string | null = null
    const needsNavigation = !currentUrl || currentUrl === 'about:blank' || (currentUrl !== req.url && !currentUrl.startsWith(req.url))
    if (needsNavigation) {
      await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
      await page.waitForLoadState('domcontentloaded').catch(() => { })
      cfClearance = await attemptCFSolve(page)
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { })
      if (await hasTurnstileIframe(page)) {
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: global.timeOut }).catch(() => { })
        cfClearance = await attemptCFSolve(page)
      }
    }
    if (req.waitFor) await sleep(Math.min(req.waitFor, 10000))
    if (req.actions?.length) await runActions(page, req.actions, returned)
    // Check turnstile once after all actions complete
    if (await hasTurnstileIframe(page)) {
      console.log('[CF] Turnstile appeared after actions — re-clicking...')
      await clickTurnstileCheckbox(page).catch(() => { })
    }
    const allCookies = await ctx.cookies()
    const userAgent = await page.evaluate(() => navigator.userAgent)
    const title = await page.title().catch(() => '')
    const finalUrl = page.url()
    const source = req.getPageSource ? await page.content().catch(() => null) : null
    const token = req.siteKey || mode === 'turnstile-max' ? await waitForToken(page, 5000) : null
    const requestProfile = await buildRequestProfile(page, ctx)
    return {
      token,
      cf_clearance: cfClearance,
      __cf_bm: allCookies.find(c => c.name === '__cf_bm')?.value ?? null,
      aws_waf_token: allCookies.find(c => c.name === 'aws-waf-token')?.value ?? null,
      cookies: fromPwCookies(allCookies as Parameters<typeof fromPwCookies>[0]),
      sessionCookies: Object.fromEntries(allCookies.map(c => [c.name, c.value])),
      userAgent, title, source, finalUrl, intercepted, returned,
      solveMs: Date.now() - start,
      proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
      mode, sessionId: req.sessionId,
      requestProfile
    }
  })
}

