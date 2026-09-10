import { Request, Response } from 'express'
import { bypassCloudflare } from '../solvers/cloudflare'
import { getOrCreate, destroy, list } from '../services/sessionStore'
import { parseUrl } from '../services/proxyManager'
import type { BypassRequest, ProxyConfig } from '../types'

const FS_VERSION = '3.4.6'
const START_TIME = Date.now()

function fsError(res: Response, message: string): void {
  res.status(500).json({
    status: 'error',
    message,
    solution: null,
    startTimestamp: Date.now(),
    endTimestamp: Date.now(),
    version: FS_VERSION,
  })
}

function fsSuccess(res: Response, solution: unknown, startTs: number): void {
  res.json({
    status: 'ok',
    message: '',
    solution,
    startTimestamp: startTs,
    endTimestamp: Date.now(),
    version: FS_VERSION,
  })
}

export async function handleFlaresolverr(req: Request, res: Response): Promise<void> {
  const startTs = Date.now()
  const { cmd, url, session, maxTimeout, proxy: fsProxy } = req.body

  if (!cmd) {
    fsError(res, 'No cmd specified')
    return
  }

  // ── Session management ──────────────────────────────────────────────────────
  if (cmd === 'sessions.create') {
    const id = session ?? `fs-${Date.now()}`
    await getOrCreate(id)
    res.json({
      status: 'ok',
      message: `Session created: ${id}`,
      session: id,
      startTimestamp: startTs,
      endTimestamp: Date.now(),
      version: FS_VERSION,
    })
    return
  }

  if (cmd === 'sessions.destroy') {
    if (!session) { fsError(res, 'session required'); return }
    await destroy(session)
    res.json({ status: 'ok', message: 'Session destroyed', startTimestamp: startTs, endTimestamp: Date.now(), version: FS_VERSION })
    return
  }

  if (cmd === 'sessions.list') {
    res.json({
      status: 'ok',
      message: '',
      sessions: list(),
      startTimestamp: startTs,
      endTimestamp: Date.now(),
      version: FS_VERSION,
    })
    return
  }

  // ── request.get / request.post ──────────────────────────────────────────────
  if (cmd !== 'request.get' && cmd !== 'request.post') {
    fsError(res, `Unknown cmd: ${cmd}`)
    return
  }

  if (!url) { fsError(res, 'url is required'); return }

  // Parse FlareSolverr proxy format: "socks5://host:port" → ProxyConfig
  let proxy: ProxyConfig | undefined
  if (fsProxy?.url) {
    proxy = parseUrl(fsProxy.url) ?? undefined
  }

  const bypassReq: BypassRequest = {
    url,
    mode: 'cloudflare',
    proxy,
    getPageSource: true,
    sessionId: session,
    waitFor: maxTimeout ? Math.min(maxTimeout, 10000) : undefined,
  }

  if (cmd === 'request.post' && req.body.postData) {
    // For POST: navigate with a form submit approach — we navigate and inject post data
    bypassReq.actions = [
      {
        type: 'evaluate',
        script: `
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = window.location.href;
          const data = ${JSON.stringify(req.body.postData)};
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = '_postdata';
          input.value = typeof data === 'string' ? data : JSON.stringify(data);
          form.appendChild(input);
          document.body.appendChild(form);
          form.submit();
        `,
      },
    ]
  }

  global.browserLength++
  try {
    const result = await bypassCloudflare(bypassReq)

    const solution = {
      url: result.finalUrl,
      status: 200,
      headers: { 'user-agent': result.userAgent },
      response: result.source ?? '',
      cookies: result.cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        size: c.name.length + c.value.length,
        httpOnly: c.httpOnly,
        secure: c.secure,
        session: !c.expires || c.expires === -1,
        sameSite: c.sameSite,
      })),
      userAgent: result.userAgent,
    }

    fsSuccess(res, solution, startTs)
  } catch (err) {
    fsError(res, (err as Error).message)
  } finally {
    global.browserLength--
  }
}
