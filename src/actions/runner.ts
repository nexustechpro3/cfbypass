import { Page } from 'patchright'
import type { ActionItem } from '../types'
import { waitForCF, sleep, safeClick } from '../solvers/base'

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
      if (!action.selector) return
      await safeClick(page, action.selector)
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
      if (!action.selector) return
      await page.waitForSelector(action.selector, { timeout })
      await page.hover(action.selector)
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
      const result = await page.evaluate(new Function(action.script) as () => unknown)
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

    default:
      console.warn(`[Actions] Unknown action type: ${(action as ActionItem).type}`)
  }
}
