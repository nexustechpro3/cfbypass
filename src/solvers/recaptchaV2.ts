import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as os from 'os'
import type { BypassRequest } from '../types'
import { withCtx, waitForCF, buildProxyUrl, sleep, registerPage } from './base'

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    https.get(url, res => {
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
    }).on('error', err => { fs.unlink(dest, () => { }); reject(err) })
  })
}

function convertMp3ToWav(mp3Path: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-i', mp3Path, '-ar', '16000', '-ac', '1', wavPath], err => {
      if (err) reject(new Error(`FFmpeg failed: ${err.message}`))
      else resolve()
    })
  })
}

async function transcribeAudio(wavPath: string): Promise<string> {
  const audioData = fs.readFileSync(wavPath)
  const base64Audio = audioData.toString('base64')
  const response = await fetch(
    'https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw',
    { method: 'POST', headers: { 'Content-Type': 'audio/x-flac; rate=16000' }, body: Buffer.from(base64Audio, 'base64') }
  )
  if (!response.ok) throw new Error('Speech-to-text request failed')
  const text = await response.text()
  for (const line of text.trim().split('\n').filter(l => l.trim())) {
    try {
      const parsed = JSON.parse(line)
      const transcript = parsed?.result?.[0]?.alternative?.[0]?.transcript
      if (transcript) return transcript.toLowerCase().trim()
    } catch (_) { }
  }
  throw new Error('Speech-to-text transcription failed — no transcript returned')
}

export async function solveRecaptchaV2(req: BypassRequest): Promise<{ token: string; solveMs: number; proxy: string | null }> {
  const start = Date.now()
  return withCtx(req.proxy, async (ctx, requestId) => {
    const page = await ctx.newPage()
    registerPage(requestId, page)

    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    await waitForCF(page)
    await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 15000 })

    const frames = page.frames()
    const rcFrame = frames.find(f => f.url().includes('google.com/recaptcha'))
    if (!rcFrame) throw new Error('reCAPTCHA iframe not found')

    await rcFrame.click('#recaptcha-anchor').catch(() => { })
    await sleep(1500)

    const passed = await rcFrame.evaluate(() =>
      document.querySelector('#recaptcha-anchor')?.getAttribute('aria-checked') === 'true'
    ).catch(() => false)

    if (passed) {
      const token = await page.evaluate(() => {
        const el = document.querySelector<HTMLTextAreaElement>('#g-recaptcha-response, [name="g-recaptcha-response"]')
        return el?.value || null
      }).catch(() => null)
      if (token && token.length > 10) {
        return { token, solveMs: Date.now() - start, proxy: req.proxy ? buildProxyUrl(req.proxy) : null }
      }
    }

    const challengeFrame = frames.find(f => f.url().includes('recaptcha/api2/bframe'))
    if (!challengeFrame) throw new Error('reCAPTCHA challenge frame not found')

    await challengeFrame.click('#recaptcha-audio-button').catch(() => { })
    await sleep(1500)

    const audioUrl = await challengeFrame.evaluate(() => {
      const link = document.querySelector<HTMLAnchorElement>('.rc-audiochallenge-tdownload-link')
      return link?.href || null
    }).catch(() => null)

    if (!audioUrl) throw new Error('Audio challenge URL not found')

    const tmpDir = os.tmpdir()
    const mp3Path = path.join(tmpDir, `rc-audio-${Date.now()}.mp3`)
    const wavPath = path.join(tmpDir, `rc-audio-${Date.now()}.wav`)

    try {
      await downloadFile(audioUrl, mp3Path)
      await convertMp3ToWav(mp3Path, wavPath)
      const transcript = await transcribeAudio(wavPath)

      await challengeFrame.fill('#audio-response', transcript)
      await sleep(300)
      await challengeFrame.click('#recaptcha-verify-button')
      await sleep(2000)

      const deadline = Date.now() + 10000
      let token: string | null = null
      while (Date.now() < deadline) {
        token = await page.evaluate(() => {
          const el = document.querySelector<HTMLTextAreaElement>('#g-recaptcha-response, [name="g-recaptcha-response"]')
          return el?.value || null
        }).catch(() => null)
        if (token && token.length > 10) break
        await sleep(500)
      }

      if (!token) throw new Error('reCAPTCHA v2 token not found after audio solve')
      return { token, solveMs: Date.now() - start, proxy: req.proxy ? buildProxyUrl(req.proxy) : null }
    } finally {
      fs.unlink(mp3Path, () => { })
      fs.unlink(wavPath, () => { })
    }
  })
}