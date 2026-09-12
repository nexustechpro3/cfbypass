import { env, pipeline } from '@xenova/transformers'
import type { BypassRequest } from '../types'
import { withCtx, waitForCF, buildProxyUrl, sleep, registerPage } from './base'
import { nextKey, solveWithGemini } from '../services/aiPool'

if (!process.env.TRANSFORMERS_CACHE) env.cacheDir = '/tmp/whisper-cache'

let _classifier: Awaited<ReturnType<typeof pipeline>> | null = null
let _classifierLoading = false

async function getClassifier() {
  if (_classifier) return _classifier
  if (_classifierLoading) { while (_classifierLoading) await sleep(200); return _classifier }
  _classifierLoading = true
  try { _classifier = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32') }
  catch (err) { console.error('[hCaptcha] Failed to load local model:', err) }
  finally { _classifierLoading = false }
  return _classifier
}

export async function solveHcaptcha(req: BypassRequest): Promise<{ token: string; solveMs: number; proxy: string | null }> {
  const start = Date.now()
  return withCtx(req.proxy, async (ctx, requestId) => {
    const page = await ctx.newPage()
    registerPage(requestId, page)

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    await waitForCF(page)
    await page.waitForSelector('iframe[src*="hcaptcha"]', { timeout: 15000 })

    const frames = page.frames()
    const hcFrame = frames.find(f => f.url().includes('hcaptcha.com'))
    if (!hcFrame) throw new Error('hCaptcha iframe not found')

    const imageUrls: string[] = await hcFrame.evaluate(() => {
      return Array.from(document.querySelectorAll<HTMLImageElement>('.task-image img')).map(i => i.src).filter(Boolean)
    }).catch(() => [])

    const challengeText: string = await hcFrame.evaluate(() => {
      return document.querySelector('.prompt-text')?.textContent?.trim() ?? ''
    }).catch(() => '')

    let answers: boolean[] = []
    let usedGemini = false

    if (imageUrls.length > 0) {
      try {
        const classifier = await getClassifier()
        if (classifier) {
          const labels = [challengeText, `not ${challengeText}`]
          answers = await Promise.all(imageUrls.map(async url => {
            const result = await (classifier as (input: string, labels: string[]) => Promise<Array<{ label: string; score: number }>>)(url, labels)
            return result[0]?.label === challengeText
          }))
        } else throw new Error('Local model unavailable')
      } catch { usedGemini = true }
    }

    if (usedGemini && imageUrls.length > 0) {
      const key = nextKey()
      if (!key) throw new Error('No Gemini API keys available')
      for (const url of imageUrls) {
        try {
          const response = await fetch(url)
          const buffer = await response.arrayBuffer()
          const base64 = Buffer.from(buffer).toString('base64')
          const answer = await solveWithGemini(base64, `Does this image contain a "${challengeText}"? Answer only "yes" or "no".`)
          answers.push(answer.toLowerCase().includes('yes'))
        } catch { answers.push(false) }
      }
    }

    const taskImages = await hcFrame.$$('.task-image')
    for (let i = 0; i < taskImages.length && i < answers.length; i++) {
      if (answers[i]) { await taskImages[i].click().catch(() => { }); await sleep(100) }
    }

    await hcFrame.click('.button-submit').catch(() => { })
    await sleep(1000)

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
    return { token, solveMs: Date.now() - start, proxy: req.proxy ? buildProxyUrl(req.proxy) : null }
  })
}