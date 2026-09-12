import type { BypassRequest, WafSessionResult } from '../types'
import { withCtx, waitForCF, fromPwCookies, buildProxyUrl, registerPage } from './base'
import { STRIP_HEADERS } from '../constants'

export async function getWafSession(req: BypassRequest): Promise<WafSessionResult> {
  const start = Date.now()
  return withCtx(req.proxy, async (ctx, requestId) => {
    const page = await ctx.newPage()
    registerPage(requestId, page)

    let resolved = false
    let resolveResult!: (r: WafSessionResult) => void
    let rejectResult!: (e: Error) => void
    const resultPromise = new Promise<WafSessionResult>((res, rej) => { resolveResult = res; rejectResult = rej })

    page.on('response', async response => {
      if (resolved) return
      const status = response.status()
      const resUrl = response.url()
      if ([200, 301, 302].includes(status) && [req.url, req.url + '/'].includes(resUrl)) {
        try {
          await page.waitForLoadState('load', { timeout: 10000 }).catch(() => { })
          await waitForCF(page)
          const allCookies = await ctx.cookies()
          const cookies = fromPwCookies(allCookies as Parameters<typeof fromPwCookies>[0])
          const userAgent = await page.evaluate(() => navigator.userAgent)
          const rawHeaders = response.headers()
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(rawHeaders)) {
            if (!STRIP_HEADERS.has(k.toLowerCase())) headers[k] = v
          }
          headers['user-agent'] = userAgent
          resolved = true
          resolveResult({ cookies, headers, proxy: req.proxy ? buildProxyUrl(req.proxy) : null, solveMs: Date.now() - start })
        } catch (err) {
          if (!resolved) { resolved = true; rejectResult(err instanceof Error ? err : new Error(String(err))) }
        }
      }
    })

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })

    if (!resolved) {
      await waitForCF(page)
      const allCookies = await ctx.cookies()
      const cookies = fromPwCookies(allCookies as Parameters<typeof fromPwCookies>[0])
      const userAgent = await page.evaluate(() => navigator.userAgent)
      resolved = true
      resolveResult({ cookies, headers: { 'user-agent': userAgent }, proxy: req.proxy ? buildProxyUrl(req.proxy) : null, solveMs: Date.now() - start })
    }

    return resultPromise
  })
}