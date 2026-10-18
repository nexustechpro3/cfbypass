import { Router, Request, Response } from 'express'
import { guard } from './middleware/guard'
import { validateBypass, validateUrl, requireSiteKey } from './middleware/validate'
import { bypassCloudflare } from './solvers/cloudflare'
import { solveTurnstileMin } from './solvers/turnstileMin'
import { solveTurnstileMax } from './solvers/turnstileMax'
import { solveCfClearance } from './solvers/cfClearance'
import { getWafSession } from './solvers/cfWaf'
import { solveAwsWaf } from './solvers/awsWaf'
import { solveHcaptcha } from './solvers/hcaptcha'
import { solveRecaptchaV2 } from './solvers/recaptchaV2'
import { solveRecaptchaV3 } from './solvers/recaptchaV3'
import { getPageSource } from './solvers/pageSource'
import { mkJob, resolveJob, rejectJob, getJob, listJobs } from './services/jobQueue'
import { record } from './services/stats'
import { broadcast } from './services/sse'
import { fire as fireWebhook } from './services/webhook'
import { getOrCreate, destroy, list } from './services/sessionStore'
import { next as nextProxy, getOne, ban, refresh, getStats as proxyStats, } from './services/proxyManager'
import { handleFlaresolverr } from './compat/flaresolverr'
import { addClient, removeClient } from './services/sse'
import { detect } from './detect/detector'
import type { BypassRequest, SolverMode } from './types'

const router = Router()

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-connection',
])

// ── HTTP CONNECT tunnel ───────────────────────────────────────────────────────
router.use((req: Request, res: Response, next) => {
  if (req.method !== 'CONNECT') return next()

  const password = req.headers['x-proxy-password'] as string
  if (!password || password !== process.env.SERVER_PROXY_PASSWORD) {
    res.writeHead(407, 'Proxy Authentication Required')
    res.end()
    return
  }

  const [host, portStr] = (req.url ?? '').split(':')
  const port = parseInt(portStr ?? '443')
  const socket = (req as any).socket

  const upstream = require('tls').connect(
    { host, port, servername: host, rejectUnauthorized: false },
    () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(socket)
      socket.pipe(upstream)
    }
  )

  upstream.on('error', (e: Error) => {
    console.error('CONNECT tunnel error:', e.message)
    socket.destroy()
  })
  socket.on('error', (e: Error) => {
    console.error('CONNECT client error:', e.message)
    upstream.destroy()
  })
})

function ok(res: Response, data: unknown): void {
  res.json({ success: true, data })
}

function fail(res: Response, code: string, message: string, status = 500): void {
  res.status(status).json({ success: false, error: { code, message } })
}

// ── Solver runner ─────────────────────────────────────────────────────────────

async function run(req: BypassRequest): Promise<unknown> {
  const mode = req.mode ?? 'cloudflare'

  if (mode === 'auto') {
    const detection = await detect(req.url, req.proxy)
    const resolvedMode = detection.mode
    console.log(`[Auto] ${req.url} → detected: ${detection.challenges.join(', ')} → solver: ${resolvedMode}`)
    const autoReq: BypassRequest = { ...req, mode: resolvedMode }
    if (!autoReq.siteKey) {
      autoReq.siteKey = detection.turnstileSiteKey ?? detection.recaptchaSiteKey ?? detection.hcaptchaSiteKey ?? undefined
    }
    return { ...(await run(autoReq) as Record<string, unknown>), detection }
  }

  switch (mode) {
    case 'cloudflare': return bypassCloudflare(req)
    case 'turnstile-min': return solveTurnstileMin(req)
    case 'turnstile-max': return solveTurnstileMax(req)
    case 'cf-clearance': return solveCfClearance(req)
    case 'waf-session': return getWafSession(req)
    case 'source': return getPageSource(req)
    case 'hcaptcha': return solveHcaptcha(req)
    case 'recaptcha-v2': return solveRecaptchaV2(req)
    case 'recaptcha-v3': return solveRecaptchaV3(req)
    case 'aws-waf': return solveAwsWaf(req)
    default: throw new Error(`Unknown mode: ${mode}`)
  }
}

async function handleSolve(req: Request, res: Response, overrides?: Partial<BypassRequest>): Promise<void> {
  const body: BypassRequest = { ...req.body, ...overrides }
  const mode: SolverMode = body.mode ?? 'cloudflare'

  broadcast('traffic', { url: body.url, mode, status: 'received' })

  if (body.useProxy && !body.proxy) {
    const p = nextProxy(body.country)
    if (!p) { fail(res, 'NO_PROXY', 'No proxy available in pool', 503); return }
    body.proxy = p
  }

  if (body.async) {
    const jobId = mkJob({ url: body.url, mode })
    ok(res, { jobId, status: 'pending' })
    broadcast('traffic', { url: body.url, mode, status: 'queued', jobId })
    global.browserLength++
    const start = Date.now()
    run(body)
      .then(result => {
        resolveJob(jobId, result)
        record(true, Date.now() - start, null, mode)
        broadcast('traffic', { url: body.url, mode, status: 'done', jobId })
        if (body.webhook) fireWebhook(body.webhook, { success: true, jobId, data: result })
      })
      .catch(err => {
        rejectJob(jobId, (err as Error).message)
        record(false, Date.now() - start, null, mode)
        broadcast('traffic', { url: body.url, mode, status: 'failed', jobId })
        if (body.webhook) fireWebhook(body.webhook, { success: false, jobId, error: (err as Error).message })
      })
      .finally(() => { global.browserLength-- })
    return
  }

  global.browserLength++
  const start = Date.now()
  try {
    const result = await run(body)
    record(true, Date.now() - start, null, mode)
    broadcast('traffic', { url: body.url, mode, status: 'done' })
    ok(res, result)
  } catch (err) {
    record(false, Date.now() - start, null, mode)
    broadcast('traffic', { url: body.url, mode, status: 'failed' })
    fail(res, 'FAILED', (err as Error).message)
  } finally {
    global.browserLength--
  }
}

// ── Main bypass endpoints ─────────────────────────────────────────────────────

router.post('/bypass', guard, validateBypass, (req, res) => handleSolve(req, res))
router.post('/bypass/batch', guard, async (req, res) => {
  const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT || '10', 10)
  const requests: BypassRequest[] = req.body.requests ?? []
  if (!Array.isArray(requests) || requests.length === 0) {
    fail(res, 'BAD_REQUEST', 'requests array is required', 400); return
  }
  if (requests.length > BATCH_LIMIT) {
    fail(res, 'BAD_REQUEST', `Max ${BATCH_LIMIT} requests per batch`, 400); return
  }
  const jobs = requests.map(r => {
    const jobId = mkJob({ url: r.url, mode: r.mode ?? 'cloudflare' })
    global.browserLength++
    const start = Date.now()
    const mode: SolverMode = r.mode ?? 'cloudflare'
    run(r)
      .then(result => { resolveJob(jobId, result); record(true, Date.now() - start, null, mode) })
      .catch(err => { rejectJob(jobId, (err as Error).message); record(false, Date.now() - start, null, mode) })
      .finally(() => { global.browserLength-- })
    return { jobId, url: r.url }
  })
  ok(res, { jobs })
})

// ── Shorthand mode routes ─────────────────────────────────────────────────────

router.post('/cloudflare', guard, validateBypass, (req, res) => handleSolve(req, res, { mode: 'cloudflare' }))
router.post('/turnstile-min', guard, validateUrl, requireSiteKey, (req, res) => handleSolve(req, res, { mode: 'turnstile-min' }))
router.post('/turnstile-max', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'turnstile-max' }))
router.post('/cf-clearance', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'cf-clearance' }))
router.post('/waf-session', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'waf-session' }))
router.post('/source', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'source' }))
router.post('/hcaptcha', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'hcaptcha' }))
router.post('/recaptcha-v2', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'recaptcha-v2' }))
router.post('/recaptcha-v3', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'recaptcha-v3' }))
router.post('/aws-waf', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'aws-waf' }))

// ── Job queue ─────────────────────────────────────────────────────────────────

router.get('/job/:id', (req, res) => {
  const job = getJob(req.params.id)
  if (!job) { fail(res, 'NOT_FOUND', 'Job not found', 404); return }
  ok(res, { jobId: req.params.id, ...job })
})

router.get('/jobs', (req, res) => {
  ok(res, { total: listJobs(50).length, jobs: listJobs(50) })
})

// ── Sessions ──────────────────────────────────────────────────────────────────

router.get('/sessions', guard, (req, res) => {
  const sessions = list()
  ok(res, { total: sessions.length, sessions })
})

router.post('/session/get', guard, async (req, res) => {
  const { url, sessionId = 'default', cookies } = req.body
  if (!url) { fail(res, 'BAD_REQUEST', 'url required', 400); return }
  global.browserLength++
  try {
    const { page } = await getOrCreate(sessionId, cookies)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    ok(res, { source: await page.content(), url: page.url(), sessionId })
  } catch (err) {
    fail(res, 'FAILED', (err as Error).message)
  } finally {
    global.browserLength--
  }
})

router.post('/session/post', guard, async (req, res) => {
  const { url, sessionId = 'default', fields = {}, cookies } = req.body
  if (!url) { fail(res, 'BAD_REQUEST', 'url required', 400); return }
  global.browserLength++
  try {
    const { page } = await getOrCreate(sessionId, cookies)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    for (const [selector, value] of Object.entries(fields)) {
      await page.fill(selector, String(value)).catch(() => { })
    }
    ok(res, { source: await page.content(), url: page.url(), sessionId })
  } catch (err) {
    fail(res, 'FAILED', (err as Error).message)
  } finally {
    global.browserLength--
  }
})

router.post('/session/destroy', async (req, res) => {
  const { sessionId } = req.body
  if (!sessionId) { fail(res, 'BAD_REQUEST', 'sessionId required', 400); return }
  await destroy(sessionId)
  ok(res, { message: 'Session destroyed', sessionId })
})

// ── Proxy ─────────────────────────────────────────────────────────────────────

router.get('/get-proxy', async (req, res) => {
  const entry = getOne(
    req.query.country as string | undefined,
    (req.query.protocol as string | undefined) ?? 'socks5',
  )
  if (!entry) { fail(res, 'NO_PROXY', 'No proxy available', 503); return }
  ok(res, entry)
})

router.post('/proxies/ban', (req, res) => {
  const { proxy } = req.body
  if (!proxy) { fail(res, 'BAD_REQUEST', 'proxy required', 400); return }
  ban(proxy)
  ok(res, { message: 'Proxy banned', proxy })
})

router.post('/proxies/refresh', async (req, res) => {
  await refresh()
  ok(res, { message: 'Refreshed', ...proxyStats() })
})

// ── Use Server As Proxy ───────────────────────────────────────────────────────

router.all('/use-as-proxy', async (req, res) => {
  const password = req.headers['x-proxy-password'] as string
  const targetUrl = req.headers['x-proxy-target'] as string

  if (!password || password !== process.env.SERVER_PROXY_PASSWORD) {
    fail(res, 'UNAUTHORIZED', 'Invalid or missing x-proxy-password header', 401); return
  }
  if (!targetUrl) {
    fail(res, 'BAD_REQUEST', 'x-proxy-target header is required', 400); return
  }

  // ── WebSocket upgrade ─────────────────────────────────────
  if (req.headers['upgrade']?.toLowerCase() === 'websocket') {
    const target = new URL(targetUrl)
    const isSecure = target.protocol === 'wss:' || target.protocol === 'https:'
    const port = target.port ? parseInt(target.port) : (isSecure ? 443 : 80)
    const host = target.hostname

    const fwdHeaders = Object.fromEntries(
      Object.entries(req.headers)
        .filter(([k, v]) => v !== undefined && k !== 'x-proxy-password' && k !== 'x-proxy-target')
    ) as Record<string, string>
    fwdHeaders['host'] = `${host}:${port}`

    const headerLines = Object.entries(fwdHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n')
    const upstream = isSecure
      ? require('tls').connect({ host, port, servername: host, rejectUnauthorized: false })
      : require('net').createConnection({ host, port })
    const socket = (res as any).socket || (req as any).socket

    upstream.on('connect', () => upstream.write(`GET ${target.pathname}${target.search || ''} HTTP/1.1\r\n${headerLines}\r\n\r\n`))
    upstream.on('data', (d: Buffer) => socket.write(d))
    upstream.on('end', () => socket.end())
    upstream.on('error', (e: Error) => { console.error('WS upstream error:', e.message); socket.destroy() })
    socket.on('data', (d: Buffer) => upstream.write(d))
    socket.on('end', () => upstream.end())
    socket.on('error', (e: Error) => { console.error('WS client error:', e.message); upstream.destroy() })
    return
  }

  // ── HTTP proxy ────────────────────────────────────────────
  try {
    const { gotScraping } = await import('got-scraping')

    const fwdHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k) || k === 'x-proxy-password' || k === 'x-proxy-target' || k === 'host') continue
      if (v !== undefined) fwdHeaders[k] = Array.isArray(v) ? v.join(', ') : v as string
    }
    fwdHeaders['host'] = new URL(targetUrl).host

    const isGetOrHead = ['GET', 'HEAD'].includes(req.method?.toUpperCase() ?? 'GET')

    const response = await gotScraping({
      url: targetUrl,
      method: (req.method ?? 'GET') as any,
      headers: fwdHeaders,
      body: isGetOrHead ? undefined : req.body,
      responseType: 'buffer',
      followRedirect: true,
      maxRedirects: 5,
      throwHttpErrors: false,
      timeout: { request: 30_000 },
      https: { rejectUnauthorized: false },
      http2: false,
    })

    res.status(response.statusCode)
    for (const [k, v] of Object.entries(response.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) res.setHeader(k, v as string)
    }
    res.send(response.body)
  } catch (err) {
    fail(res, 'PROXY_ERROR', (err as Error).message)
  }
})

// ── Detect ────────────────────────────────────────────────────────────────────

router.post('/detect', guard, validateUrl, async (req, res) => {
  const { url, proxy, useProxy, country } = req.body
  let resolvedProxy = proxy
  if (useProxy && !resolvedProxy) resolvedProxy = nextProxy(country) ?? undefined
  global.browserLength++
  try {
    ok(res, await detect(url, resolvedProxy))
  } catch (err) {
    fail(res, 'FAILED', (err as Error).message)
  } finally {
    global.browserLength--
  }
})

router.post('/bypass/auto', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'auto' }))

// ── FlareSolverr compat ───────────────────────────────────────────────────────

router.post('/v1', (req, res) => handleFlaresolverr(req, res))

// ── SSE ───────────────────────────────────────────────────────────────────────

router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send: import('./types').SseSendFn = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  addClient(send)
  req.on('close', () => removeClient(send))
})

export default router