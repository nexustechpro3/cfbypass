import { chromium, BrowserContext } from 'patchright'
import { buildHeaderProfile } from '../headers/chrome128'
import * as path from 'path'
import * as os from 'os'

import * as fs from 'fs'

let _context: BrowserContext | null = null
let _ready = false
let _restarting = false
let _currentProfileDir = ''

declare global {
  var browserLength: number
  var browserLimit: number
  var timeOut: number
}

global.browserLength = 0
global.browserLimit = parseInt(process.env.BROWSER_LIMIT || '20', 10)
global.timeOut = parseInt(process.env.TIMEOUT_MS || '120000', 10)

const COMMON_FLAGS = [
  '--disable-save-password-bubble',
  '--disable-single-click-autofill',
  '--disable-autofill-keyboard-accessory-view',
  '--password-store=basic',
  '--disable-features=AutofillServerCommunication,AutofillEnableAccountWalletStorage,PasswordManager,PrivateNetworkAccessPermissionPrompt,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults',
  '--allow-insecure-localhost',
  '--no-default-browser-check',
  '--use-fake-ui-for-media-stream',
]

const PERMISSIONS = [
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-write',
] as const

const IS_LINUX = process.platform === 'linux'

const LAUNCH_OPTIONS = IS_LINUX
  ? {
    headless: process.env.HEADED !== 'true',
    viewport: null as null,
    permissions: PERMISSIONS as unknown as string[],
    args: [
      ...COMMON_FLAGS,
    ],
  }
  : {
    channel: 'chrome' as const,
    headless: false,
    viewport: null as null,
    permissions: PERMISSIONS as unknown as string[],
    args: [
      ...COMMON_FLAGS,
    ],
  }

function cleanProfileDir(dirPath: string): void {
  try {
    if (dirPath && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true })
      console.log(`[BrowserPool] Cleaned profile directory: ${dirPath}`)
    }
  } catch (err) {
    console.warn(`[BrowserPool] Could not delete profile directory ${dirPath}:`, err)
  }
}

function getFreshProfileDir(): string {
  if (process.env.USER_DATA_DIR) {
    cleanProfileDir(process.env.USER_DATA_DIR)
    return process.env.USER_DATA_DIR
  }

  const baseDir = path.join(os.tmpdir(), 'nexus-clearance-profile')
  try {
    if (fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
    return baseDir
  } catch (_) {
    // If files are locked, create a fresh unique directory to ensure 100% clean state
    return path.join(os.tmpdir(), `nexus-clearance-profile-${Date.now()}`)
  }
}

async function launch(): Promise<void> {
  _currentProfileDir = getFreshProfileDir()
  console.log(`[BrowserPool] Launching with clean profile: ${_currentProfileDir}`)

  _context = await chromium.launchPersistentContext(_currentProfileDir, LAUNCH_OPTIONS)

  const browser = _context.browser()
  const versionStr = browser ? browser.version() : 'Chrome/128.0.0.0'
  console.log(`[BrowserPool] Browser version: ${versionStr}`)
  buildHeaderProfile(versionStr)

  _context.on('close', () => {
    console.log('[BrowserPool] Browser context closed — auto-restarting...')
    _ready = false
    _context = null
    cleanProfileDir(_currentProfileDir)
    if (!_restarting) scheduleRestart()
  })
}

function scheduleRestart(): void {
  _restarting = true
  setTimeout(async () => {
    try {
      await launch()
      _ready = true
      _restarting = false
      console.log('[BrowserPool] Browser auto-restarted')
    } catch (err) {
      console.error('[BrowserPool] Auto-restart failed, retrying in 5s:', err)
      _restarting = false
      scheduleRestart()
    }
  }, 2000)
}

export async function init(): Promise<void> {
  console.log('[BrowserPool] Launching Patchright browser...')
  try {
    await launch()
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
  _restarting = true
  try { await _context?.close() } catch (_) { }
  _context = null
  cleanProfileDir(_currentProfileDir)
  await launch()
  _ready = true
  _restarting = false
  console.log('[BrowserPool] Browser restarted with clean state')
}

export async function shutdown(): Promise<void> {
  _ready = false
  _restarting = true
  try { await _context?.close() } catch (_) { }
  _context = null
  cleanProfileDir(_currentProfileDir)
  console.log('[BrowserPool] Browser closed and profile cleaned')
}

export function getPersistentContext(): BrowserContext {
  if (!_context) throw new Error('Browser not initialized')
  return _context
}

export function getBrowser() {
  return _context?.browser() ?? null
}

export function isReady(): boolean {
  return _ready && _context !== null
}