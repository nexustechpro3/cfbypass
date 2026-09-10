import type { BypassRequest, CookieParam } from '../types'
import { withCtx, setupPage, fromPwCookies, buildProxyUrl, sleep } from './base'

const AWS_WAF_POLL_INTERVAL = 800
const AWS_WAF_TIMEOUT = 30000

export async function solveAwsWaf(req: BypassRequest): Promise<{
  aws_waf_token: string
  cookies: CookieParam[]
  userAgent: string
  solveMs: number
  proxy: string | null
}> {
  const start = Date.now()

  return withCtx(req.proxy, async ctx => {
    const page = await ctx.newPage()
    await setupPage(page)

    // Full Sec-Fetch headers — AWS WAF Bot Control validates these
    await page.setExtraHTTPHeaders({
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
    })

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })

    // Poll for aws-waf-token cookie
    const deadline = Date.now() + AWS_WAF_TIMEOUT
    let awsWafToken: string | null = null

    while (Date.now() < deadline) {
      const cookies = await ctx.cookies()
      const tokenCookie = cookies.find(c => c.name === 'aws-waf-token')
      if (tokenCookie?.value) {
        awsWafToken = tokenCookie.value
        break
      }
      await sleep(AWS_WAF_POLL_INTERVAL)
    }

    if (!awsWafToken) throw new Error('aws-waf-token cookie not found after timeout')

    const allCookies = await ctx.cookies()
    const cookies = fromPwCookies(allCookies as Parameters<typeof fromPwCookies>[0])
    const userAgent = await page.evaluate(() => navigator.userAgent)

    return {
      aws_waf_token: awsWafToken,
      cookies,
      userAgent,
      solveMs: Date.now() - start,
      proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
    }
  })
}
