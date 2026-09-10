import { chromium, Browser } from 'patchright'
import { buildHeaderProfile } from '../headers/chrome128'

let _browser: Browser | null = null
let _ready = false

// Declare globals for concurrency tracking (used by guard middleware)
declare global {
  var browserLength: number
  var browserLimit: number
  var timeOut: number
}

global.browserLength = 0
global.browserLimit = parseInt(process.env.BROWSER_LIMIT || '20', 10)
global.timeOut = parseInt(process.env.TIMEOUT_MS || '120000', 10)

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',     // Amendment 3: mandatory — Railway/Docker /dev/shm is 64MB
  '--single-process',             // Amendment 4: saves 100–200MB RAM per instance on Railway
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--window-size=1920,1080',
  '--lang=en-US',
  // NOTE: Do NOT add --disable-blink-features=AutomationControlled — Patchright handles internally
  // NOTE: Do NOT add --expose-gc — Railway does not allow it (amendment 5)
]

export async function init(): Promise<void> {
  console.log('[BrowserPool] Launching Patchright browser...')
  try {
    _browser = await chromium.launch({
      headless: process.env.HEADED !== 'true',
      args: LAUNCH_ARGS,
    })

    // Amendment 2: Build dynamic header profile from actual browser version
    const versionStr = _browser.version()
    console.log(`[BrowserPool] Browser version: ${versionStr}`)
    buildHeaderProfile(versionStr)

    _browser.on('disconnected', () => {
      console.log('[BrowserPool] Browser disconnected')
      _ready = false
      _browser = null
    })

    _ready = true
    console.log('[BrowserPool] Browser ready')
  } catch (err) {
    console.error('[BrowserPool] Failed to launch browser:', err)
    throw err
  }
}

export async function restart(): Promise<void> {
  console.log('[BrowserPool] Restarting browser...')
  _ready = false
  try {
    await _browser?.close()
  } catch (_) { /* ignore close errors */ }
  _browser = null
  await init()
}

export async function shutdown(): Promise<void> {
  _ready = false
  if (_browser) {
    try {
      await _browser.close()
    } catch (_) { /* ignore */ }
    _browser = null
  }
  console.log('[BrowserPool] Browser closed')
}

export function getBrowser(): Browser {
  if (!_browser) throw new Error('Browser not initialized')
  return _browser
}

export function isReady(): boolean {
  return _ready && _browser !== null
}
