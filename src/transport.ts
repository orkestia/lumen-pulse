import type { PulseEvent } from './types.js'

export interface TransportConfig {
  ingestUrl: string
  writeKey: string
  fetchImpl: typeof fetch
  onError?: (error: unknown) => void
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

export async function sendBatch(
  events: PulseEvent[],
  config: TransportConfig,
): Promise<void> {
  if (events.length === 0) return
  const url = joinUrl(config.ingestUrl, '/api/product/ingest/batch')
  try {
    const res = await config.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Primary Pulse credential header (matches Lumen ops + product_auth).
        'x-api-key': config.writeKey,
        // Also send Bearer for proxies / older scaffolds.
        authorization: `Bearer ${config.writeKey}`,
      },
      body: JSON.stringify({ events }),
      keepalive: true,
    })
    if (!res.ok) {
      config.onError?.(new Error(`lumen-pulse ingest failed: HTTP ${res.status}`))
    }
  } catch (err) {
    config.onError?.(err)
  }
}
