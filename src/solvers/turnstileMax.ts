import type { BypassRequest } from '../types'
import { withCtx, setupPage, waitForCF, waitForToken, buildProxyUrl } from './base'

export async function solveTurnstileMax(req: BypassRequest): Promise<{ token: string; solveMs: number; proxy: string | null }> {
  const start = Date.now()

  return withCtx(req.proxy, async ctx => {
    const page = await ctx.newPage()
    await setupPage(page)

    // Inject init script: polls window.turnstile.getResponse() every 400ms,
    // writes result to hidden input [name="cf-response"]
    await page.addInitScript({ content: `
      (function() {
        var _interval = setInterval(function() {
          try {
            var t = window.turnstile && window.turnstile.getResponse();
            if (t && t.length > 10) {
              var el = document.querySelector('[name="cf-response"]');
              if (!el) {
                el = document.createElement('input');
                el.type = 'hidden';
                el.name = 'cf-response';
                document.body.appendChild(el);
              }
              el.value = t;
              clearInterval(_interval);
            }
          } catch(e) {}
        }, 400);
      })();
    ` })

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    await waitForCF(page)

    const token = await waitForToken(page, 60000)
    if (!token) throw new Error('Failed to get Turnstile token from live page')

    return {
      token,
      solveMs: Date.now() - start,
      proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
    }
  })
}
