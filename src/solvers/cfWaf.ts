import type { BypassRequest, WafSessionResult } from '../types'
import { withCtx, setupPage, waitForCF, fromPwCookies, buildProxyUrl } from './base'
import { STRIP_HEADERS } from '../constants'

export async function getWafSession(req: BypassRequest): Promise<WafSessionResult> {
  const start = Date.now()

  return withCtx(req.proxy, async ctx => {
    const page = await ctx.newPage()
    await setupPage(page)

    let resolved = false
    let resolveResult!: (r: WafSessionResult) => void
    let rejectResult!: (e: Error) => void

    const resultPromise = new Promise<WafSessionResult>((res, rej) => {
      resolveResult = res
      rejectResult = rej
    })

    // Watch for the first 200/301/302 response to the target URL
    page.on('response', async response => {
      if (resolved) return
      const resUrl = response.url()
      const status = response.status()

      if ([200, 301, 302].includes(status) && [req.url, req.url + '/'].includes(resUrl)) {
        try {
          // Wait for page to load
          await page.waitForLoadState('load', { timeout: 10000 }).catch(() => { /* ok */ })
          await waitForCF(page)

          const allCookies = await ctx.cookies()
          const cookies = fromPwCookies(allCookies as Parameters<typeof fromPwCookies>[0])

          const userAgent = await page.evaluate(() => navigator.userAgent)

          // Collect response headers, strip non-replay-able headers
          const rawHeaders = response.headers()
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(rawHeaders)) {
            if (!STRIP_HEADERS.has(k.toLowerCase())) {
              headers[k] = v
            }
          }
          headers['user-agent'] = userAgent

          resolved = true
          resolveResult({
            cookies,
            headers,
            proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
            solveMs: Date.now() - start,
          })
        } catch (err) {
          if (!resolved) {
            resolved = true
            rejectResult(err instanceof Error ? err : new Error(String(err)))
          }
        }
      }
    })

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })

    // Fallback if response event never fired
    if (!resolved) {
      await waitForCF(page)
      const allCookies = await ctx.cookies()
      const cookies = fromPwCookies(allCookies as Parameters<typeof fromPwCookies>[0])
      const userAgent = await page.evaluate(() => navigator.userAgent)
      resolved = true
      resolveResult({
        cookies,
        headers: { 'user-agent': userAgent },
        proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
        solveMs: Date.now() - start,
      })
    }

    return resultPromise
  })
}
