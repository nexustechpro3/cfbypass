import * as fs from 'fs'
import * as path from 'path'
import type { BypassRequest } from '../types'
import { withCtx, waitForToken, buildProxyUrl, registerPage } from './base'

const FAKEPAGE_PATH = path.resolve(__dirname, '../../data/fakepage.html')

export async function solveTurnstileMin(req: BypassRequest): Promise<{ token: string; solveMs: number; proxy: string | null }> {
  if (!req.siteKey) throw new Error('siteKey is required for turnstile-min')
  const start = Date.now()
  const fakeHtml = fs.readFileSync(FAKEPAGE_PATH, 'utf-8').replace(/<site-key>/g, req.siteKey)

  return withCtx(req.proxy, async (ctx, requestId) => {
    const page = await ctx.newPage()
    registerPage(requestId, page)

    await page.route(
      (url) => [req.url, req.url + '/'].includes(url.href),
      async route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeHtml })
    )

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const token = await waitForToken(page, 60000)
    if (!token) throw new Error('Failed to get Turnstile token')
    return { token, solveMs: Date.now() - start, proxy: req.proxy ? buildProxyUrl(req.proxy) : null }
  })
}