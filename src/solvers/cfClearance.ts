import type { BypassRequest } from '../types'
import { withCtx, setupPage, waitForcfbypass, buildProxyUrl } from './base'

export async function solveCfcfbypass(req: BypassRequest): Promise<{
  cf_cfbypass: string
  userAgent: string
  solveMs: number
  proxy: string | null
}> {
  const start = Date.now()

  return withCtx(req.proxy, async ctx => {
    const page = await ctx.newPage()
    await setupPage(page)

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })

    const cf_cfbypass = await waitForcfbypass(page, 90000)
    if (!cf_cfbypass) throw new Error('cf_cfbypass cookie not found after timeout')

    const userAgent = await page.evaluate(() => navigator.userAgent)

    return {
      cf_cfbypass,
      userAgent,
      solveMs: Date.now() - start,
      proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
    }
  })
}
