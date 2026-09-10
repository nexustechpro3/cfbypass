import { Router, Request, Response } from 'express'
import { guard } from './middleware/guard'
import { validateBypass, validateUrl, requireSiteKey } from './middleware/validate'
import { bypassCloudflare } from './solvers/cloudflare'
import { solveTurnstileMin } from './solvers/turnstileMin'
import { solveTurnstileMax } from './solvers/turnstileMax'
import { solveCfcfbypass } from './solvers/cfcfbypass'
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
import { next as nextProxy, getOne, ban, refresh, getStats as proxyStats, validateAndScore } from './services/proxyManager'
import { handleFlaresolverr } from './compat/flaresolverr'
import { addClient, removeClient } from './services/sse'
import { detect } from './detect/detector'
import type { BypassRequest, SolverMode } from './types'

const router = Router()

function ok(res: Response, data: unknown): void {
  res.json({ success: true, data })
}

function fail(res: Response, code: string, message: string, status = 500): void {
  res.status(status).json({ success: false, error: { code, message } })
}

// ── Solver runner ─────────────────────────────────────────────────────────────

async function run(req: BypassRequest): Promise<unknown> {
  const mode = req.mode ?? 'cloudflare'

  // Auto-detect mode: sniff the page, pick the right solver, then solve
  if (mode === 'auto') {
    const detection = await detect(req.url, req.proxy)
    const resolvedMode = detection.mode
    console.log(`[Auto] ${req.url} → detected: ${detection.challenges.join(', ')} → solver: ${resolvedMode}`)

    // Carry detected siteKey into request if not already set
    const autoReq: BypassRequest = { ...req, mode: resolvedMode }
    if (!autoReq.siteKey) {
      autoReq.siteKey = detection.turnstileSiteKey
        ?? detection.recaptchaSiteKey
        ?? detection.hcaptchaSiteKey
        ?? undefined
    }

    const result = await run(autoReq)
    // Attach detection metadata to result
    return { ...( result as Record<string, unknown>), detection }
  }

  switch (mode) {
    case 'cloudflare':     return bypassCloudflare(req)
    case 'turnstile-min':  return solveTurnstileMin(req)
    case 'turnstile-max':  return solveTurnstileMax(req)
    case 'cf-cfbypass':   return solveCfcfbypass(req)
    case 'waf-session':    return getWafSession(req)
    case 'source':         return getPageSource(req)
    case 'hcaptcha':       return solveHcaptcha(req)
    case 'recaptcha-v2':   return solveRecaptchaV2(req)
    case 'recaptcha-v3':   return solveRecaptchaV3(req)
    case 'aws-waf':        return solveAwsWaf(req)
    default:               throw new Error(`Unknown mode: ${mode}`)
  }
}

async function handleSolve(req: Request, res: Response, overrides?: Partial<BypassRequest>): Promise<void> {
  const body: BypassRequest = { ...req.body, ...overrides }
  const mode: SolverMode = body.mode ?? 'cloudflare'

  broadcast('traffic', { url: body.url, mode, status: 'received' })

  // Resolve proxy from pool if requested
  if (body.useProxy && !body.proxy) {
    const p = nextProxy(body.country)
    if (!p) { fail(res, 'NO_PROXY', 'No proxy available in pool', 503); return }
    body.proxy = p
  }

  // Async mode — return jobId immediately
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

  // Sync mode
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

router.post('/cloudflare',    guard, validateBypass, (req, res) => handleSolve(req, res, { mode: 'cloudflare' }))
router.post('/turnstile-min', guard, validateUrl, requireSiteKey, (req, res) => handleSolve(req, res, { mode: 'turnstile-min' }))
router.post('/turnstile-max', guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'turnstile-max' }))
router.post('/cf-cfbypass',  guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'cf-cfbypass' }))
router.post('/waf-session',   guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'waf-session' }))
router.post('/source',        guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'source' }))
router.post('/hcaptcha',      guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'hcaptcha' }))
router.post('/recaptcha-v2',  guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'recaptcha-v2' }))
router.post('/recaptcha-v3',  guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'recaptcha-v3' }))
router.post('/aws-waf',       guard, validateUrl, (req, res) => handleSolve(req, res, { mode: 'aws-waf' }))

// ── Job queue ─────────────────────────────────────────────────────────────────

router.get('/job/:id', (req, res) => {
  const job = getJob(req.params.id)
  if (!job) { fail(res, 'NOT_FOUND', 'Job not found', 404); return }
  ok(res, { jobId: req.params.id, ...job })
})

router.get('/jobs', (req, res) => {
  const jobs = listJobs(50)
  ok(res, { total: jobs.length, jobs })
})

// ── Sessions ──────────────────────────────────────────────────────────────────

router.post('/session/get', guard, async (req, res) => {
  const { url, sessionId = 'default', cookies } = req.body
  if (!url) { fail(res, 'BAD_REQUEST', 'url required', 400); return }
  global.browserLength++
  try {
    const page = await getOrCreate(sessionId, cookies)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    const source = await page.content()
    ok(res, { source, url: page.url(), sessionId })
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
    const page = await getOrCreate(sessionId, cookies)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: global.timeOut })
    for (const [selector, value] of Object.entries(fields)) {
      await page.fill(selector, String(value)).catch(() => { /* ignore missing fields */ })
    }
    const source = await page.content()
    ok(res, { source, url: page.url(), sessionId })
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
  const country = req.query.country as string | undefined
  const entry = getOne(country)
  if (!entry) { fail(res, 'NO_PROXY', 'No proxy available', 503); return }
  // Live-test and score it
  const scored = await validateAndScore(entry.url)
  ok(res, scored ?? entry)
})

router.post('/proxies/ban', (req, res) => {
  const { proxy } = req.body
  if (!proxy) { fail(res, 'BAD_REQUEST', 'proxy required', 400); return }
  ban(proxy)
  ok(res, { message: 'Proxy banned', proxy })
})

router.post('/proxies/refresh', async (req, res) => {
  await refresh()
  const stats = proxyStats()
  ok(res, { message: 'Refreshed', ...stats })
})

// ── Auto-detect + detect endpoints ───────────────────────────────────────────

// POST /detect — sniff the page and return what challenges are present (no solving)
router.post('/detect', guard, validateUrl, async (req, res) => {
  const { url, proxy, useProxy, country } = req.body

  let resolvedProxy = proxy
  if (useProxy && !resolvedProxy) {
    const p = nextProxy(country)
    if (p) resolvedProxy = p
  }

  global.browserLength++
  try {
    const result = await detect(url, resolvedProxy)
    ok(res, result)
  } catch (err) {
    fail(res, 'FAILED', (err as Error).message)
  } finally {
    global.browserLength--
  }
})

// POST /bypass/auto — detect then solve in one call
router.post('/bypass/auto', guard, validateUrl, (req, res) =>
  handleSolve(req, res, { mode: 'auto' })
)

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
