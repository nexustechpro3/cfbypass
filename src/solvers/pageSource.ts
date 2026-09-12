import type { BypassRequest } from '../types'
import { withCtx, waitForCF, buildProxyUrl, registerPage } from './base'

export async function getPageSource(req: BypassRequest): Promise<{ source: string; solveMs: number; proxy: string | null }> {
  const start = Date.now()
  return withCtx(req.proxy, async (ctx, requestId) => {
    const page = await ctx.newPage()
    registerPage(requestId, page)

    let resolved = false
    let resolveSource!: (s: string) => void
    let rejectSource!: (e: Error) => void
    const sourcePromise = new Promise<string>((res, rej) => { resolveSource = res; rejectSource = rej })

    page.on('response', async response => {
      if (resolved) return
      const status = response.status()
      const resUrl = response.url()
      if ([200, 301, 302].includes(status) && [req.url, req.url + '/'].includes(resUrl)) {
        try {
          await page.waitForLoadState('load', { timeout: 10000 }).catch(() => { })
          await waitForCF(page)
          resolved = true
          resolveSource(await page.content())
        } catch (err) {
          if (!resolved) { resolved = true; rejectSource(err instanceof Error ? err : new Error(String(err))) }
        }
      }
    })

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    if (!resolved) {
      await waitForCF(page)
      resolved = true
      resolveSource(await page.content())
    }

    const source = await sourcePromise
    return { source, solveMs: Date.now() - start, proxy: req.proxy ? buildProxyUrl(req.proxy) : null }
  })
}