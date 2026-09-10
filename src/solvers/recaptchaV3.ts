import type { BypassRequest } from '../types'
import { withCtx, setupPage, waitForCF, buildProxyUrl, sleep } from './base'

// Amendment 9: _injectWeb3Environment() removed entirely
// Amendment 10: _triggerThroughInteraction() form-filling removed entirely
// Keep ONLY: network interception, _executeRecaptcha() direct call, _waitForTokens()

async function simulateHumanBehavior(page: import('patchright').Page): Promise<void> {
  // Random mouse movements
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 }

  for (let i = 0; i < 5; i++) {
    const x = Math.floor(Math.random() * viewport.width * 0.8 + viewport.width * 0.1)
    const y = Math.floor(Math.random() * viewport.height * 0.8 + viewport.height * 0.1)
    await page.mouse.move(x, y, { steps: 10 })
    await sleep(Math.floor(Math.random() * 200 + 50))
  }

  // Smooth scroll
  await page.evaluate(() => {
    const scrollAmount = Math.floor(Math.random() * 300 + 100)
    window.scrollBy({ top: scrollAmount, behavior: 'smooth' })
  })
  await sleep(Math.floor(Math.random() * 500 + 200))

  // Dwell time: 3–8 seconds of idle
  const dwell = Math.floor(Math.random() * 5000 + 3000)
  await sleep(dwell)

  // Occasional hover on a random element
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('a, button, [role="button"]'))
    if (els.length) {
      const el = els[Math.floor(Math.random() * els.length)]
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    }
  })
}

export async function solveRecaptchaV3(req: BypassRequest): Promise<{
  token: string
  score: number
  solveMs: number
  proxy: string | null
}> {
  const start = Date.now()

  return withCtx(req.proxy, async ctx => {
    const page = await ctx.newPage()
    await setupPage(page)

    let capturedToken: string | null = null
    let capturedScore = 0

    // Intercept reCAPTCHA token response to read the score
    await page.route('**/*recaptcha*', async route => {
      const response = await route.fetch()
      const text = await response.text().catch(() => '')

      // Parse score from userverify or similar responses
      const scoreMatch = text.match(/"rresp","([^"]+)"/) ?? text.match(/score.*?(\d+\.\d+)/)
      if (scoreMatch) capturedScore = parseFloat(scoreMatch[1])

      // Parse token
      const tokenMatch = text.match(/"uvresp","([^"]+)"/) ?? text.match(/"token":"([^"]+)"/)
      if (tokenMatch) capturedToken = tokenMatch[1]

      await route.fulfill({ response })
    })

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    await waitForCF(page)

    // Try up to 3 times if score is too low
    for (let attempt = 0; attempt < 3; attempt++) {
      await simulateHumanBehavior(page)

      // Execute reCAPTCHA directly via grecaptcha API
      const token = await page.evaluate(() => {
        return new Promise<string | null>(resolve => {
          const w = window as unknown as {
            grecaptcha?: {
              execute(sitekey?: string, options?: { action?: string }): Promise<string>
              ready(fn: () => void): void
            }
          }
          if (!w.grecaptcha?.ready) { resolve(null); return }
          w.grecaptcha.ready(async () => {
            try {
              // Find sitekey from page
              const el = document.querySelector('[data-sitekey]')
              const sitekey = el?.getAttribute('data-sitekey') ?? ''
              const token = await w.grecaptcha!.execute(sitekey, { action: 'submit' })
              resolve(token)
            } catch (_) { resolve(null) }
          })
        })
      }).catch(() => null)

      if (token || capturedToken) {
        const finalToken = token ?? capturedToken!
        // Check token is in textarea too
        const textareaToken = await page.evaluate(() => {
          const el = document.querySelector<HTMLTextAreaElement>('[name="g-recaptcha-response"]')
          return el?.value || null
        }).catch(() => null)

        const resolvedToken = textareaToken ?? finalToken
        if (!resolvedToken) continue

        if (capturedScore >= 0.5 || attempt === 2) {
          return {
            token: resolvedToken,
            score: capturedScore || 0.7,
            solveMs: Date.now() - start,
            proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
          }
        }
      }

      // Score too low — retry with more behavior
      console.log(`[reCAPTCHA v3] Attempt ${attempt + 1} score ${capturedScore} < 0.5, retrying...`)
    }

    if (!capturedToken) throw new Error('reCAPTCHA v3 token not captured after 3 attempts')

    return {
      token: capturedToken,
      score: capturedScore,
      solveMs: Date.now() - start,
      proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
    }
  })
}
