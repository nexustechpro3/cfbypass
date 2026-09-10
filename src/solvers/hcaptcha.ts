import { env, pipeline } from '@xenova/transformers'
import type { BypassRequest } from '../types'
import { withCtx, setupPage, waitForCF, buildProxyUrl, sleep } from './base'
import { nextKey, solveWithGemini } from '../services/aiPool'

// Amendment 6: Set Xenova cache to /tmp — configured via env in Dockerfile
// But also set it here as a safety net
if (!process.env.TRANSFORMERS_CACHE) {
  env.cacheDir = '/tmp/whisper-cache'
}

let _classifier: Awaited<ReturnType<typeof pipeline>> | null = null
let _classifierLoading = false

async function getClassifier() {
  if (_classifier) return _classifier
  if (_classifierLoading) {
    // Wait for it
    while (_classifierLoading) await sleep(200)
    return _classifier
  }
  _classifierLoading = true
  try {
    _classifier = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32')
  } catch (err) {
    console.error('[hCaptcha] Failed to load local model:', err)
  } finally {
    _classifierLoading = false
  }
  return _classifier
}

export async function solveHcaptcha(req: BypassRequest): Promise<{ token: string; solveMs: number; proxy: string | null }> {
  const start = Date.now()

  return withCtx(req.proxy, async ctx => {
    const page = await ctx.newPage()
    await setupPage(page)

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    await waitForCF(page)

    // Wait for hCaptcha to appear
    await page.waitForSelector('iframe[src*="hcaptcha"]', { timeout: 15000 })

    // Switch to hCaptcha iframe
    const frames = page.frames()
    const hcFrame = frames.find(f => f.url().includes('hcaptcha.com'))
    if (!hcFrame) throw new Error('hCaptcha iframe not found')

    // Extract challenge images
    const imageUrls: string[] = await hcFrame.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.task-image img'))
      return imgs.map(i => i.src).filter(Boolean)
    }).catch(() => [])

    const challengeText: string = await hcFrame.evaluate(() => {
      const el = document.querySelector('.prompt-text')
      return el?.textContent?.trim() ?? ''
    }).catch(() => '')

    let answers: boolean[] = []
    let usedGemini = false

    // Try local model first
    if (imageUrls.length > 0) {
      try {
        const classifier = await getClassifier()
        if (classifier) {
          const labels = [challengeText, `not ${challengeText}`]
          const results = await Promise.all(
            imageUrls.map(async (url) => {
              const result = await (classifier as (input: string, labels: string[]) => Promise<Array<{ label: string; score: number }>>)(url, labels)
              return result[0]?.label === challengeText
            })
          )
          answers = results
        } else {
          throw new Error('Local model unavailable')
        }
      } catch (err) {
        console.log('[hCaptcha] Local model failed, falling back to Gemini:', err)
        usedGemini = true
      }
    }

    // Gemini fallback
    if (usedGemini && imageUrls.length > 0) {
      const key = nextKey()
      if (!key) throw new Error('No Gemini API keys available')

      for (let i = 0; i < imageUrls.length; i++) {
        try {
          const prompt = `Does this image contain a "${challengeText}"? Answer only "yes" or "no".`
          // Convert URL to base64 for Gemini
          const response = await fetch(imageUrls[i])
          const buffer = await response.arrayBuffer()
          const base64 = Buffer.from(buffer).toString('base64')
          const answer = await solveWithGemini(base64, prompt)
          answers.push(answer.toLowerCase().includes('yes'))
        } catch (_) {
          answers.push(false)
        }
      }
    }

    // Click selected images
    const taskImages = await hcFrame.$$('.task-image')
    for (let i = 0; i < taskImages.length && i < answers.length; i++) {
      if (answers[i]) {
        await taskImages[i].click().catch(() => { /* ignore */ })
        await sleep(100)
      }
    }

    // Submit
    await hcFrame.click('.button-submit').catch(() => { /* ignore */ })
    await sleep(1000)

    // Poll for h-captcha-response token
    const deadline = Date.now() + 15000
    let token: string | null = null
    while (Date.now() < deadline) {
      token = await page.evaluate(() => {
        const el = document.querySelector<HTMLTextAreaElement>('[name="h-captcha-response"], #h-captcha-response')
        return el?.value || null
      }).catch(() => null)
      if (token && token.length > 10) break
      await sleep(500)
    }

    if (!token) throw new Error('hCaptcha token not found after solving')

    return {
      token,
      solveMs: Date.now() - start,
      proxy: req.proxy ? buildProxyUrl(req.proxy) : null,
    }
  })
}
