/**
 * Chrome header profile — built DYNAMICALLY at startup from browser.version().
 * Amendment 2: Never hardcode Chrome version. Parse actual version string at init.
 */

let _ua = ''
let _headers: Record<string, string> = {}
let _headersXhr: Record<string, string> = {}
let _axiosHeaders: Record<string, string> = {}
let _chromeVersion = ''

/**
 * Call once after browserPool.init().
 * versionStr is the string returned by browser.version() e.g. "Chromium/128.0.6613.119"
 */
export function buildHeaderProfile(versionStr: string): void {
  // Parse major version from e.g. "Chromium/128.0.6613.119" or "Chrome/128.0.6613.119"
  const match = versionStr.match(/(?:Chromium|Chrome)\/(\d+)\./)
  _chromeVersion = match ? match[1] : '128'

  _ua =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${_chromeVersion}.0.0.0 Safari/537.36`

  // Exact header set Chrome sends on first navigation, in exact order.
  // sec-ch-ua version MUST match UA version string.
  // zstd in Accept-Encoding is Chrome 121+ — absence is a detection signal.
  _headers = {
    'User-Agent': _ua,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'sec-ch-ua': `"Chromium";v="${_chromeVersion}", "Not;A=Brand";v="24", "Google Chrome";v="${_chromeVersion}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    Connection: 'keep-alive',
  }

  // For XHR/fetch inside a site
  _headersXhr = {
    ..._headers,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  }

  _axiosHeaders = { ..._headers }
}

export function getChromeUA(): string {
  return _ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
}

export function getChromeHeaders(): Record<string, string> {
  return _headers
}

export function getChromeHeadersXhr(): Record<string, string> {
  return _headersXhr
}

export function getAxiosHeaders(): Record<string, string> {
  return _axiosHeaders
}

export function getChromeVersion(): string {
  return _chromeVersion
}

// HTTP/2 SETTINGS — real Chrome values.
// Default bot HTTP/2 uses HEADER_TABLE_SIZE=4096, INITIAL_WINDOW_SIZE=65535 — detected.
export const HTTP2_SETTINGS = {
  HEADER_TABLE_SIZE: 65536,
  MAX_CONCURRENT_STREAMS: 1000,
  INITIAL_WINDOW_SIZE: 6291456,
  MAX_FRAME_SIZE: 16384,
}
