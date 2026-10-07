import { Page, Response } from 'patchright'
import type { BypassRequest, BypassResult } from '../types'
import { runActions } from '../actions/runner'
import {
  withSessionOrCtx, setupPage, waitForClearance, waitForCF, waitForToken,
  toPwCookies, fromPwCookies, sleep, buildProxyUrl, registerPage,
} from './base'

import { execSync } from 'child_process'

const IS_LINUX = process.platform === 'linux'

async function clickTurnstileCheckbox(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 15000 })
    await sleep(3000)

    const iframe = page.locator('iframe[src*="challenges.cloudflare.com"]')
    const box = await iframe.boundingBox()
    if (!box) {
      console.log('[CF] Could not get iframe bounding box')
      return false
    }

    if (IS_LINUX) {
      const display = process.env.DISPLAY || ':99'
      const winPos = execSync(`DISPLAY=${display} xdotool getactivewindow getwindowgeometry --shell`).toString()
      const winX = parseInt(winPos.match(/X=(-?\d+)/)?.[1] ?? '0')
      const winY = parseInt(winPos.match(/Y=(-?\d+)/)?.[1] ?? '0')

      const offsetY = winY < 0 ? 0 : winY
      const clickX = Math.round((winX < 0 ? 0 : winX) + box.x + 30)
      const clickY = Math.round(offsetY + 85 + box.y + box.height / 2)

      console.log(`[CF] xdotool clicking at: ${clickX}, ${clickY}`)
      execSync(`DISPLAY=${display} xdotool mousemove ${clickX} ${clickY} click 1`)
      return true
    }

    // Windows — use Playwright mouse
    const x = box.x + 30
    const y = box.y + box.height / 2
    await page.mouse.move(x, y, { steps: 10 })
    await sleep(150)
    await page.mouse.click(x, y)
    console.log(`[CF] Clicked at (${x.toFixed(0)}, ${y.toFixed(0)})`)
    return true

  } catch (err) {
    console.log('[CF] Checkbox click failed:', (err as Error).message)
    return false
  }
}

async function attemptCFSolve(page: Page): Promise<string | null> {
  const MAX_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const title = await page.title().catch(() => '')
    const isCFChallenge = [
      'just a moment', 'checking your browser', 'verifying you are human',
      'security check', 'please wait', 'attention required',
    ].some(t => title.toLowerCase().includes(t))

    console.log(`[CF] Attempt ${attempt + 1} — title: "${title}", isChallenge: ${isCFChallenge}`)

    if (!isCFChallenge) {
      const cookies = await page.context().cookies()
      return cookies.find(c => c.name === 'cf_clearance')?.value ?? null
    }

    const html = await page.content().catch(() => '')
    const cType = html.match(/cType:\s*'([^']+)'/)?.[1] ?? null
    console.log(`[CF] cType: ${cType ?? 'unknown'}`)

    if (cType === 'managed' || cType === 'interactive' || isCFChallenge) {
      const autoCleared = await waitForClearance(page, 20000)
      if (autoCleared) return autoCleared
      await clickTurnstileCheckbox(page)
      await sleep(3000)
      const cleared = await waitForClearance(page, 30000)
      if (cleared) return cleared
      const newTitle = await page.title().catch(() => '')
      const stillOnCF = ['just a moment', 'checking your browser', 'verifying you are human']
        .some(t => newTitle.toLowerCase().includes(t))
      if (!stillOnCF) {
        const cookies = await page.context().cookies()
        return cookies.find(c => c.name === 'cf_clearance')?.value ?? null
      }
    } else {
      await waitForCF(page, 30000)
      const cookies = await page.context().cookies()
      const clearance = cookies.find(c => c.name === 'cf_clearance')?.value ?? null
      if (clearance) return clearance
    }

    if (attempt < MAX_ATTEMPTS - 1) await sleep(2000)
  }

  const finalCookies = await page.context().cookies()
  return finalCookies.find(c => c.name === 'cf_clearance')?.value ?? null
}

export async function bypassCloudflare(req: BypassRequest): Promise<BypassResult> {
  const start = Date.now()
  const mode = req.mode ?? 'cloudflare'

  return withSessionOrCtx(req, async (ctx, page, requestId, isSession) => {
    const intercepted: Record<string, unknown> = {}
    const returned: Record<string, unknown> = {}

    if (req.setCookies?.length) {
      await ctx.addCookies(toPwCookies(req.url, req.setCookies))
    }

    if (req.intercept?.length) {
      page.on('response', async (response: Response) => {
        for (const rule of req.intercept!) {
          if (response.url().includes(rule.url)) {
            try {
              if (rule.type === 'json') intercepted[rule.url] = await response.json().catch(() => null)
              else if (rule.type === 'text') intercepted[rule.url] = await response.text().catch(() => null)
              else {
                const buf = await response.body().catch(() => null)
                intercepted[rule.url] = buf ? buf.toString('base64') : null
              }
            } catch (_) { }
          }
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
      if (submitSelector) await page.click(submitSelector)
      if (waitAfterLogin) await sleep(waitAfterLogin)
    }

    const currentUrl = page.url()
    let cfClearance: string | null = null

    // If session tab is already on target site, avoid redundant full page reloads unless necessary
    const needsNavigation = !currentUrl || currentUrl === 'about:blank' || (currentUrl !== req.url && !currentUrl.startsWith(req.url))

    if (needsNavigation) {
      await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
      await sleep(6000)
      cfClearance = await attemptCFSolve(page)
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { })
    }

    if (req.waitFor) await sleep(Math.min(req.waitFor, 10000))
    if (req.actions?.length) await runActions(page, req.actions, returned)

    const allCookies = await ctx.cookies()
    const cfCookies = fromPwCookies(allCookies as Parameters<typeof fromPwCookies>[0])
    const sessionCookies: Record<string, string> = {}
    for (const c of allCookies) sessionCookies[c.name] = c.value

    const userAgent = await page.evaluate(() => navigator.userAgent)
    const title = await page.title().catch(() => '')
    const finalUrl = page.url()
    const source = req.getPageSource ? await page.content().catch(() => null) : null

    let token: string | null = null
    if (req.siteKey || mode === 'turnstile-max') token = await waitForToken(page, 5000)

    const cfBm = allCookies.find(c => c.name === '__cf_bm')?.value ?? null
    const awsWafToken = allCookies.find(c => c.name === 'aws-waf-token')?.value ?? null

    return {
      token, cf_clearance: cfClearance, __cf_bm: cfBm, aws_waf_token: awsWafToken,
      cookies: cfCookies, sessionCookies, userAgent, title, source, finalUrl,
      intercepted, returned, solveMs: Date.now() - start,
      proxy: req.proxy ? buildProxyUrl(req.proxy) : null, mode,
      sessionId: req.sessionId,
    }
  })
}