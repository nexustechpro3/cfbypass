import type { BypassRequest } from '../types'
import { withCtx, setupPage, waitForClearance, buildProxyUrl } from './base'

export async function solveCfClearance(req: BypassRequest): Promise<{
  cf_clearance: string
  userAgent: string
  solveMs: number
  proxy: string | null
}> {
  const start = Date.now()

  return withCtx(req.proxy, async ctx => {
    const page = await ctx.newPage()
    await setupPage(page)

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })

    const cf_clearance = await waitForClearance(page, 90000)
    if (!cf_clearance) throw new Error('cf_clearance cookie not found after timeout')

    const userAgent = await page.evaluate(() => navigator.userAgent)

    return {
      cf_clearance,
      userAgent,
      solveMs: Date.now() - start,
      proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
    }
  })
}
