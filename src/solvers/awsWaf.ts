import type { BypassRequest, CookieParam } from '../types'
import { withCtx, fromPwCookies, buildProxyUrl, sleep, registerPage } from './base'

export async function solveAwsWaf(req: BypassRequest): Promise<{
  aws_waf_token: string; cookies: CookieParam[]; userAgent: string; solveMs: number; proxy: string | null
}> {
  const start = Date.now()
  return withCtx(req.proxy, async (ctx, requestId) => {
    const page = await ctx.newPage()
    registerPage(requestId, page)

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })

    const deadline = Date.now() + 30000
    let awsWafToken: string | null = null
    while (Date.now() < deadline) {
      const cookies = await ctx.cookies()
      const tokenCookie = cookies.find(c => c.name === 'aws-waf-token')
      if (tokenCookie?.value) { awsWafToken = tokenCookie.value; break }
      await sleep(800)
    }

    if (!awsWafToken) throw new Error('aws-waf-token cookie not found after timeout')

    const allCookies = await ctx.cookies()
    const cookies = fromPwCookies(allCookies as Parameters<typeof fromPwCookies>[0])
    const userAgent = await page.evaluate(() => navigator.userAgent)

    return { aws_waf_token: awsWafToken, cookies, userAgent, solveMs: Date.now() - start, proxy: req.proxy ? buildProxyUrl(req.proxy) : null }
  })
}