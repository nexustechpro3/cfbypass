import { Request, Response, NextFunction } from 'express'
import { isReady } from '../pool/browserPool'

function fail(res: Response, code: string, message: string, status: number): void {
  res.status(status).json({ success: false, error: { code, message } })
}

export function guard(req: Request, res: Response, next: NextFunction): void {
  if (!isReady()) {
    fail(res, 'NOT_READY', 'Browser not ready — please retry in a moment', 503)
    return
  }
  if (global.browserLength >= global.browserLimit) {
    fail(res, 'TOO_MANY', 'At maximum capacity — please retry later', 429)
    return
  }
  next()
}
