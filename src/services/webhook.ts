import axios from 'axios'
import type { WebhookConfig } from '../types'
import { getAxiosHeaders } from '../headers/chrome128'

export async function fire(config: WebhookConfig, payload: unknown): Promise<void> {
  try {
    await axios({
      method: config.method ?? 'POST',
      url: config.url,
      data: payload,
      headers: {
        ...getAxiosHeaders(),
        'Content-Type': 'application/json',
        ...(config.headers ?? {}),
      },
      timeout: 10000,
    })
  } catch (err) {
    // Silent fail — webhook errors must never propagate to the solver
    console.error('[Webhook] Failed to fire:', (err as Error).message)
  }
}
