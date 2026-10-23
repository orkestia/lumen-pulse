import type { PulseEvent } from './types.js'

/**
 * Browsers cap the total body of in-flight `keepalive` requests at 64 KiB.
 * Stay a little under so headers / encoding slack never push us over.
 */
export const MAX_BODY_BYTES = 60 * 1024

/** Longest `Retry-After` we will wait for before giving up on a batch. */
export const MAX_RETRY_AFTER_MS = 10_000

const BASE_RETRY_MS = 500
const RETRY_JITTER_MS = 1000

export interface TransportConfig {
  ingestUrl: string
  writeKey: string
  fetchImpl: typeof fetch
  onError?: (error: unknown) => void
}

/** Error passed to `onError` when the ingest API rejects a batch. */
export class LumenPulseError extends Error {
  /** HTTP status, or 0 for network errors. */
  readonly status: number
  /** Server error code, e.g. `PULSE_RATE_LIMITED`, when the body carried one. */
  readonly code: string | undefined
  /** Number of events dropped with this batch. */
  readonly dropped: number

  constructor(message: string, status: number, code: string | undefined, dropped: number) {
    super(message)
    this.name = 'LumenPulseError'
    this.status = status
    this.code = code
    this.dropped = dropped
  }
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

export function byteLength(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length * 3
}

/**
 * Split events into request bodies of at most `maxEvents` events and
 * `maxBytes` bytes each. An event larger than `maxBytes` on its own still gets
 * its own chunk (sent without keepalive by `sendBatch`).
 */
export function chunkEvents(
  events: PulseEvent[],
  maxEvents: number,
  maxBytes: number = MAX_BODY_BYTES,
): PulseEvent[][] {
  const envelope = byteLength('{"events":[]}')
  const chunks: PulseEvent[][] = []
  let current: PulseEvent[] = []
  let size = envelope
  for (const event of events) {
    const eventBytes = byteLength(JSON.stringify(event))
    // +1 for the comma separating it from the previous event
    if (current.length > 0 && (current.length >= maxEvents || size + 1 + eventBytes > maxBytes)) {
      chunks.push(current)
      current = []
      size = envelope
    }
    size += (current.length > 0 ? 1 : 0) + eventBytes
    current.push(event)
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Milliseconds to wait from a `Retry-After` header (seconds or HTTP date). */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - now)
}

function isRetryable(status: number, code: string | undefined): boolean {
  // A spent monthly quota is a 429 too, but retrying cannot help.
  if (code === 'PULSE_QUOTA_EXCEEDED' || code === 'REPLAY_QUOTA_EXCEEDED') return false
  return status === 429 || status >= 500
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: unknown }
    return typeof body.code === 'string' ? body.code : undefined
  } catch {
    return undefined
  }
}

type Attempt =
  | { ok: true }
  | { ok: false; retryable: boolean; retryAfterMs: number | null; error: LumenPulseError }

async function attempt(
  url: string,
  body: string,
  keepalive: boolean,
  count: number,
  config: TransportConfig,
  label: string,
): Promise<Attempt> {
  let res: Response
  try {
    res = await config.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Primary Pulse credential header (matches Lumen ops + product_auth).
        'x-api-key': config.writeKey,
        // Also send Bearer for proxies / older scaffolds.
        authorization: `Bearer ${config.writeKey}`,
      },
      body,
      keepalive,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      retryable: true,
      retryAfterMs: null,
      error: new LumenPulseError(`lumen-pulse ${label} failed: ${message}`, 0, undefined, count),
    }
  }
  if (res.ok) return { ok: true }
  const code = await readErrorCode(res)
  return {
    ok: false,
    retryable: isRetryable(res.status, code),
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    error: new LumenPulseError(
      `lumen-pulse ${label} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`,
      res.status,
      code,
      count,
    ),
  }
}

/**
 * POST a JSON body to `path` under `ingestUrl`. Network errors, 5xx and 429
 * are retried once (after `Retry-After` when present, else a jittered
 * backoff); other 4xx and spent quotas are never retried. `keepalive` is used
 * when the body fits the browser's keepalive budget. Resolves with the final
 * error, or null on success. Never rejects.
 */
export async function postWithRetry(
  path: string,
  body: string,
  count: number,
  config: TransportConfig,
  label = 'ingest',
): Promise<LumenPulseError | null> {
  const url = joinUrl(config.ingestUrl, path)
  // keepalive lets the request outlive the page (unload flush), but only
  // for bodies under the browser's 64 KiB keepalive budget.
  const keepalive = byteLength(body) <= MAX_BODY_BYTES

  const first = await attempt(url, body, keepalive, count, config, label)
  if (first.ok) return null
  if (!first.retryable) return first.error

  let delay: number
  if (first.retryAfterMs !== null) {
    if (first.retryAfterMs > MAX_RETRY_AFTER_MS) return first.error
    delay = first.retryAfterMs
  } else {
    delay = BASE_RETRY_MS + Math.random() * RETRY_JITTER_MS
  }
  await sleep(delay)

  const second = await attempt(url, body, keepalive, count, config, label)
  return second.ok ? null : second.error
}

/**
 * POST one chunk of events (see `postWithRetry` for the retry rule). On final
 * failure the chunk is dropped and `onError` is called.
 */
export async function sendBatch(
  events: PulseEvent[],
  config: TransportConfig,
): Promise<void> {
  if (events.length === 0) return
  const error = await postWithRetry(
    '/api/product/ingest/batch',
    JSON.stringify({ events }),
    events.length,
    config,
  )
  if (error) config.onError?.(error)
}
