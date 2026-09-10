import { Request, Response, NextFunction } from 'express'
import { SOLVER_MODES } from '../constants'
import type { SolverMode } from '../types'

function fail(res: Response, message: string): void {
  res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message } })
}

export function validateBypass(req: Request, res: Response, next: NextFunction): void {
  const { url, mode, waitFor } = req.body

  if (!url || typeof url !== 'string') {
    fail(res, 'url is required and must be a string')
    return
  }

  try {
    new URL(url)
  } catch {
    fail(res, `Invalid url: ${url}`)
    return
  }

  if (mode !== undefined && !SOLVER_MODES.includes(mode as SolverMode)) {
    fail(res, `Invalid mode "${mode}". Must be one of: ${SOLVER_MODES.join(', ')}`)
    return
  }

  if (waitFor !== undefined && (typeof waitFor !== 'number' || waitFor < 0 || waitFor > 10000)) {
    fail(res, 'waitFor must be a number between 0 and 10000')
    return
  }

  next()
}

export function validateUrl(req: Request, res: Response, next: NextFunction): void {
  const { url } = req.body
  if (!url || typeof url !== 'string') {
    fail(res, 'url is required')
    return
  }
  try { new URL(url) } catch {
    fail(res, `Invalid url: ${url}`)
    return
  }
  next()
}

export function requireSiteKey(req: Request, res: Response, next: NextFunction): void {
  if (!req.body.siteKey) {
    fail(res, 'siteKey is required for this mode')
    return
  }
  next()
}
