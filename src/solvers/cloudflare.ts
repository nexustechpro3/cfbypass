import { Page, Response } from 'patchright'
import type { BypassRequest, BypassResult } from '../types'
import { runActions } from '../actions/runner'
import {
  withSessionOrCtx, waitForClearance, waitForCF, waitForToken,
  toPwCookies, fromPwCookies, sleep, buildProxyUrl,
} from './base'
import { execSync } from 'child_process'

const IS_LINUX = process.platform === 'linux'

async function hasTurnstileIframe(page: Page): Promise<boolean> {
  return page.$('iframe[src*="challenges.cloudflare.com"]').then(el => !!el).catch(() => false)
}

async function clickTurnstileCheckbox(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 15000 })
    await sleep(3000)
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '')
    console.log(`[CF] Page text: ${pageText.replace(/\n/g, ' ')}`)
    const iframeEl = await page.$('iframe[src*="challenges.cloudflare.com"]')
    await iframeEl?.scrollIntoViewIfNeeded()
    await sleep(1000)
    const frame = await iframeEl?.contentFrame()
    if (!frame) { console.log('[CF] No contentFrame'); return false }
    await frame.waitForSelector('input[type="checkbox"]:not([disabled])', { timeout: 30000, state: 'visible' })
    await sleep(1000)
    for (let i = 0; i < 2; i++) {
      try {
        await frame.locator('input[type="checkbox"]').click()
        console.log(`[CF] Clicked via contentFrame (attempt ${i + 1})`)
        return true
      } catch {
        console.log(`[CF] contentFrame click attempt ${i + 1} failed`)
        if (i === 0) await sleep(6000)
      }
    }
    console.log('[CF] contentFrame exhausted, falling back to xdotool')
    const box = await page.locator('iframe[src*="challenges.cloudflare.com"]').boundingBox()
    if (!box) { console.log('[CF] No bounding box'); return false }
    if (!IS_LINUX) {
      const x = box.x + 30
      const y = box.y + box.height / 2
      await page.mouse.move(x, y, { steps: 10 })
      await sleep(150)
      await page.mouse.click(x, y)
      console.log(`[CF] Clicked via mouse at (${x.toFixed(0)}, ${y.toFixed(0)})`)
      return true
    }
    const display = process.env.DISPLAY || ':99'
    const windowId = (page.context() as any)._windowId
    const winInfo = execSync(`DISPLAY=${display} xdotool getwindowgeometry ${windowId} 2>/dev/null`).toString()
    const posMatch = winInfo.match(/Position:\s*(-?\d+),(-?\d+)/)
    const winX = parseInt(posMatch?.[1] ?? '0')
    const winY = parseInt(posMatch?.[2] ?? '0')
    const clickX = Math.round(winX + box.x + 30)
    const clickY = Math.round(winY + 85 + box.y + box.height / 2)
    console.log(`[CF] Window at: ${winX},${winY} | xdotool clicking at: ${clickX},${clickY}`)
    execSync(`DISPLAY=${display} xdotool mousemove ${clickX} ${clickY} click 1`)
    return true
  } catch (err) {
    console.log('[CF] Checkbox click failed:', (err as Error).message)
    return false
  }
}

async function attemptCFSolve(page: Page): Promise<string | null> {
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
      await sleep(5000)
      const cleared = await waitForClearance(page, 30000)
      if (cleared) return cleared
      const stillHasWidget = await hasTurnstileIframe(page)
      if (!isCF(await page.title().catch(() => '')) && !stillHasWidget) return getClearance()
    } else {
      await waitForCF(page, 30000)
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
            else {
              const buf = await response.body().catch(() => null)
              intercepted[rule.url] = buf ? buf.toString('base64') : null
            }
          } catch { }
        }
      })
    }
    if (req.login) {
      const { loginUrl, usernameSelector, passwordSelector, submitSelector, username, password, waitAfterLogin } = req.login
      await page.goto(loginUrl, { waitUntil: 'load', timeout: global.timeOut })
      await sleep(2000)
      await attemptCFSolve(page)
      if (usernameSelector && username) {
        await page.waitForSelector(usernameSelector, { timeout: 10000 })
        await page.fill(usernameSelector, username)
      }
      if (passwordSelector && password) {
        await page.waitForSelector(passwordSelector, { timeout: 10000 })
        await page.fill(passwordSelector, password)
      }
      await attemptCFSolve(page) // catch inline widget after filling form
      if (submitSelector) await page.click(submitSelector)
      if (waitAfterLogin) await sleep(waitAfterLogin)
    }
    const currentUrl = page.url()
    let cfClearance: string | null = null
    const needsNavigation = !currentUrl || currentUrl === 'about:blank' || (currentUrl !== req.url && !currentUrl.startsWith(req.url))
    if (needsNavigation) {
      await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
      await sleep(3000)
      cfClearance = await attemptCFSolve(page)
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { })
      // check again after networkidle in case inline widget appeared after load
      if (await hasTurnstileIframe(page)) {
        await sleep(3000) // wait for any lazy content to finish shifting the layout
        cfClearance = await attemptCFSolve(page)
      }
    }
    if (req.waitFor) await sleep(Math.min(req.waitFor, 10000))
    if (req.actions?.length) await runActions(page, req.actions, returned)
    const allCookies = await ctx.cookies()
    const userAgent = await page.evaluate(() => navigator.userAgent)
    const title = await page.title().catch(() => '')
    const finalUrl = page.url()
    const source = req.getPageSource ? await page.content().catch(() => null) : null
    const token = req.siteKey || mode === 'turnstile-max' ? await waitForToken(page, 5000) : null
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
    }
  })
}