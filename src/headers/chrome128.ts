let _chromeVersion = ''

export function buildHeaderProfile(versionStr: string): void {
  const match = versionStr.match(/(?:Chromium|Chrome)\/(\d+)\./)
  _chromeVersion = match ? match[1] : '128'
}

export function getAxiosHeaders(): Record<string, string> {
  const v = _chromeVersion || '128'
  return {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'sec-ch-ua': `"Chromium";v="${v}", "Not;A=Brand";v="24", "Google Chrome";v="${v}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Connection': 'keep-alive',
  }
}

export function getChromeVersion(): string {
  return _chromeVersion
}

export const HTTP2_SETTINGS = {
  HEADER_TABLE_SIZE: 65536,
  MAX_CONCURRENT_STREAMS: 1000,
  INITIAL_WINDOW_SIZE: 6291456,
  MAX_FRAME_SIZE: 16384,
}