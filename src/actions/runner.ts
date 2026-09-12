import { Page } from 'patchright'
import axios from 'axios'
import type { ActionItem } from '../types'
import { waitForCF, sleep, safeClick } from '../solvers/base'

function generateTrace(targetX: number, targetY: number): Array<[number, number, number]> {
  const startX = Math.floor(Math.random() * 800 + 100)
  const startY = Math.floor(Math.random() * 400 + 100)
  const points: Array<[number, number, number]> = []
  const steps = 35 + Math.floor(Math.random() * 20)
  let t = 30000 + Math.floor(Math.random() * 2000)
  for (let i = 0; i <= steps; i++) {
    const p = i / steps
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
    const x = Math.round(startX + (targetX - startX) * ease + (Math.random() - 0.5) * 8)
    const y = Math.round(startY + (targetY - startY) * ease + (Math.random() - 0.5) * 8)
    points.push([x, y, t])
    t += 14 + Math.floor(Math.random() * 10)
    if (Math.random() < 0.08) t += 40 + Math.floor(Math.random() * 60)
  }
  points.push([targetX, targetY, t])
  return points
}

/**
 * Runs the actions pipeline. Per spec: try/catch per action — never throws and kills solver.
 * Stores evaluateAndReturn / screenshot results in `returned` map.
 */
export async function runActions(
  page: Page,
  actions: ActionItem[],
  returned: Record<string, unknown>
): Promise<void> {
  for (const action of actions) {
    try {
      await runAction(page, action, returned)
    } catch (err) {
      console.error(`[Actions] Action "${action.type}" failed:`, err)
      // Per spec: log and continue
    }
  }
}

async function runAction(page: Page, action: ActionItem, returned: Record<string, unknown>): Promise<void> {
  const timeout = action.timeout ?? 10000

  switch (action.type) {
    case 'click': {
      // Optional trace replay before clicking
      if (Array.isArray(action.trace) && action.trace.length > 0) {
        for (const pt of action.trace) {
          const px = Array.isArray(pt) ? pt[0] : pt.x
          const py = Array.isArray(pt) ? pt[1] : pt.y
          if (typeof px === 'number' && typeof py === 'number') {
            await page.mouse.move(px, py)
          }
        }
      }

      const posX = action.offsetX ?? action.x
      const posY = action.offsetY ?? action.y

      if (action.selector) {
        if (posX !== undefined && posY !== undefined) {
          await page.waitForSelector(action.selector, { timeout })
          await page.click(action.selector, { position: { x: posX, y: posY }, timeout })
        } else {
          await safeClick(page, action.selector)
        }
        break
      }

      if (action.x !== undefined && action.y !== undefined) {
        await page.mouse.click(action.x, action.y)
        break
      }
      break
    }

    case 'type': {
      if (!action.selector || action.value === undefined) return
      await page.waitForSelector(action.selector, { timeout })
      await page.fill(action.selector, action.value)
      break
    }

    case 'scroll': {
      const x = action.x ?? 0
      const y = action.y ?? 300
      await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y])
      break
    }

    case 'hover': {
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout })
        await page.hover(action.selector)
        break
      }
      if (action.x !== undefined && action.y !== undefined) {
        await page.mouse.move(action.x, action.y)
        break
      }
      break
    }

    case 'select': {
      if (!action.selector || action.value === undefined) return
      await page.waitForSelector(action.selector, { timeout })
      await page.selectOption(action.selector, action.value)
      break
    }

    case 'keypress': {
      if (!action.key) return
      await page.keyboard.press(action.key)
      break
    }

    case 'wait': {
      await sleep(action.ms ?? action.wait ?? 1000)
      break
    }

    case 'navigate': {
      if (!action.url) return
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout })
      await waitForCF(page)
      break
    }

    case 'waitForSelector': {
      if (!action.selector) return
      await page.waitForSelector(action.selector, { timeout })
      break
    }

    case 'waitForText': {
      if (!action.text) return
      await page.waitForFunction(
        (t: string) => document.body.innerText.includes(t),
        action.text,
        { timeout }
      )
      break
    }

    case 'waitForURL': {
      if (!action.url) return
      await page.waitForFunction(
        (u: string) => window.location.href.includes(u),
        action.url,
        { timeout }
      )
      break
    }

    case 'evaluate': {
      if (!action.script) return
      // fire and forget
      await page.evaluate(new Function(action.script) as () => unknown)
      break
    }

    case 'evaluateAndReturn': {
      if (!action.script) return
      let result: unknown
      try {
        result = await page.evaluate(new Function(action.script) as () => unknown)
        if (result === undefined && !action.script.includes('return')) {
          try {
            result = await page.evaluate(new Function(`return (${action.script})`) as () => unknown)
          } catch (_) { }
        }
      } catch (_) {
        result = await page.evaluate(new Function(`return (${action.script})`) as () => unknown)
      }
      if (action.name) {
        returned[action.name] = result
      }
      break
    }

    case 'screenshot': {
      const buf = await page.screenshot({ fullPage: action.fullPage ?? false })
      const key = action.name ?? `screenshot_${Date.now()}`
      returned[key] = buf.toString('base64')
      break
    }

    case 'resolve':
    case 'solveCanvas': {
      const selector = action.selector ?? 'canvas'
      const timeout = action.timeout ?? 15000
      await page.waitForSelector(selector, { timeout }).catch(() => { })

      // 1. Extract element image (canvas toDataURL or element screenshot) & dimensions
      const canvasData = await page.evaluate((sel) => {
        const el = document.querySelector<HTMLElement>(sel)
        if (!el) return null
        const rect = el.getBoundingClientRect()
        let imageBase64 = ''
        let w = rect.width
        let h = rect.height

        if (el instanceof HTMLCanvasElement) {
          w = el.width || rect.width
          h = el.height || rect.height
          imageBase64 = el.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
        }
        return {
          imageBase64,
          w: Math.round(w),
          h: Math.round(h),
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        }
      }, selector)

      if (!canvasData) {
        console.warn(`[Actions] resolve: element "${selector}" not found`)
        break
      }

      // If element wasn't a canvas or didn't provide imageBase64, take element screenshot
      if (!canvasData.imageBase64) {
        const el = await page.$(selector)
        if (el) {
          const buf = await el.screenshot()
          canvasData.imageBase64 = buf.toString('base64')
        }
      }

      if (!canvasData.imageBase64) {
        console.warn(`[Actions] resolve: could not capture image from "${selector}"`)
        break
      }

      let parsedCoords: { x: number; y: number } | null = null
      let rawApiResponse: unknown = null

      // 2. Caller-defined HTTP request
      if (action.request) {
        const reqConfig = action.request
        let url = reqConfig.url
          .replace(/\{\{w\}\}/g, String(canvasData.w))
          .replace(/\{\{h\}\}/g, String(canvasData.h))

        let body = reqConfig.body
        if (body !== undefined) {
          const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
          const replaced = bodyStr
            .replace(/\{\{image\}\}/g, canvasData.imageBase64)
            .replace(/\{\{imageBase64\}\}/g, canvasData.imageBase64)
            .replace(/\{\{w\}\}/g, String(canvasData.w))
            .replace(/\{\{h\}\}/g, String(canvasData.h))
          try {
            body = JSON.parse(replaced)
          } catch (_) {
            body = replaced
          }
        }

        console.log(`[Actions] resolve: dispatching caller request to ${url}...`)
        const res = await axios({
          url,
          method: (reqConfig.method ?? 'POST') as any,
          headers: reqConfig.headers ?? { 'Content-Type': 'application/json' },
          data: body,
          timeout: reqConfig.timeout ?? 60000,
          validateStatus: s => s < 600,
        })

        if (res.status >= 400) {
          throw new Error(`Resolver API returned HTTP ${res.status}: ${JSON.stringify(res.data).substring(0, 250)}`)
        }

        rawApiResponse = res.data
        let targetText = ''

        if (reqConfig.responsePath) {
          const parts = reqConfig.responsePath.replace(/\[(\w+)\]/g, '.$1').split('.')
          let val: any = res.data
          for (const p of parts) {
            val = val?.[p]
          }
          targetText = typeof val === 'string' ? val : JSON.stringify(val ?? '')
        } else {
          targetText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
        }

        // Search for JSON with x and y coordinates
        const match = targetText.match(/\{[^{}]*"x"\s*:\s*([0-9.]+)[^{}]*"y"\s*:\s*([0-9.]+)[^{}]*\}/i)
          || targetText.match(/\{[^{}]*"y"\s*:\s*([0-9.]+)[^{}]*"x"\s*:\s*([0-9.]+)[^{}]*\}/i)

        if (match) {
          const start = targetText.indexOf('{')
          const end = targetText.lastIndexOf('}')
          try {
            const parsed = JSON.parse(targetText.substring(start, end + 1))
            if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
              parsedCoords = { x: parsed.x, y: parsed.y }
            }
          } catch (_) {
            const xVal = parseFloat(match[1])
            const yVal = parseFloat(match[2])
            if (!isNaN(xVal) && !isNaN(yVal)) parsedCoords = { x: xVal, y: yVal }
          }
        } else {
          throw new Error(`Could not find { x, y } coordinates in API response: ${targetText.substring(0, 150)}`)
        }
      } else if (action.geminiKey || process.env.GEMINI_API_KEY) {
        // Fallback convenience if caller passed geminiKey without full request object
        const key = action.geminiKey || process.env.GEMINI_API_KEY
        const model = action.model || 'gemini-2.5-flash'
        const prompt = action.prompt || (
          `This is a CAPTCHA image, exactly ${canvasData.w} pixels wide and ${canvasData.h} pixels tall. ` +
          `Locate the correct shape. Respond with ONLY a JSON object: {"x": 123, "y": 456}. No markdown.`
        )
        const geminiRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { contents: [{ parts: [{ inline_data: { mime_type: 'image/png', data: canvasData.imageBase64 } }, { text: prompt }] }] },
          { headers: { 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: s => s < 600 }
        )
        rawApiResponse = geminiRes.data
        const text = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        if (start !== -1 && end !== -1) {
          const parsed = JSON.parse(text.substring(start, end + 1))
          parsedCoords = { x: parsed.x, y: parsed.y }
        }
      } else {
        throw new Error('resolve action requires a "request" configuration object')
      }

      if (!parsedCoords) {
        throw new Error('Failed to resolve coordinates from solver response')
      }

      const x = Math.min(Math.max(Math.round(parsedCoords.x), 0), canvasData.w)
      const y = Math.min(Math.max(Math.round(parsedCoords.y), 0), canvasData.h)

      const scaleX = canvasData.rect.width / canvasData.w
      const scaleY = canvasData.rect.height / canvasData.h
      const pageX = Math.round(canvasData.rect.left + x * scaleX)
      const pageY = Math.round(canvasData.rect.top + y * scaleY)
      const trace = generateTrace(x, y)

      console.log(`[Actions] resolve: target coords x=${x}, y=${y} (page: ${pageX}, ${pageY})`)

      // 3. Store in window for subsequent evaluate actions and extract cid & csrf
      const pageInfo = await page.evaluate(({ x, y, pageX, pageY, trace }) => {
        const perf = performance.getEntriesByType('resource')
        const vfyEntry = perf.find((e: any) => e.name?.includes?.('/sys/vfy/i/')) as any
        let cid = null
        if (vfyEntry) {
          const match = vfyEntry.name.match(/\/sys\/vfy\/i\/([^?]+)/)
          if (match) cid = match[1]
        }
        const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.getAttribute('content') ?? ''

        ;(window as any).__nexus_x__ = x
        ;(window as any).__nexus_y__ = y
        ;(window as any).__nexus_pageX__ = pageX
        ;(window as any).__nexus_pageY__ = pageY
        ;(window as any).__nexus_cid__ = cid
        ;(window as any).__nexus_csrf__ = csrf
        ;(window as any).__nexus_trace__ = trace

        return { cid, csrf }
      }, { x, y, pageX, pageY, trace }).catch(() => ({ cid: null, csrf: '' }))

      // 4. Click at coordinates unless explicitly disabled
      if (action.click !== false) {
        console.log(`[Actions] resolve: clicking at page coordinates (${pageX}, ${pageY})...`)
        // Native mouse movement + click via Playwright
        await page.mouse.move(pageX, pageY).catch(() => { })
        await sleep(50)
        await page.mouse.click(pageX, pageY).catch(() => { })

        // In-page synthetic event dispatch to ensure canvas event listeners trigger
        await page.evaluate(({ selector, pageX, pageY }) => {
          const el = document.querySelector(selector)
          if (!el) return
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: pageX, clientY: pageY }))
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: pageX, clientY: pageY }))
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: pageX, clientY: pageY }))
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: pageX, clientY: pageY }))
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: pageX, clientY: pageY }))
        }, { selector, pageX, pageY }).catch(() => { })
      }

      const result = {
        x,
        y,
        pageX,
        pageY,
        cid: pageInfo?.cid ?? null,
        csrf: pageInfo?.csrf ?? '',
        trace,
        response: rawApiResponse,
      }
      const key = action.name ?? 'resolve'
      returned[key] = result
      break
    }

    default:
      console.warn(`[Actions] Unknown action type: ${(action as ActionItem).type}`)
  }
}
