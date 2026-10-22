import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LumenPulseError,
  MAX_BODY_BYTES,
  chunkEvents,
  parseRetryAfter,
  sendBatch,
} from '../src/transport.js'
import type { PulseEvent } from '../src/types.js'

function event(i: number, extra = ''): PulseEvent {
  return {
    signal_kind: 'product',
    event_id: `e${i}`,
    event_name: 'test',
    occurred_at: '2026-10-22T00:00:00.000Z',
    project: 'p',
    anonymous_id: null,
    user_id: null,
    session_id: 's',
    properties: extra ? { extra } : {},
    context: {},
  }
}

function errorResponse(status: number, code?: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(code ? { error: 'x', code } : { error: 'x' }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

async function run(promise: Promise<void>) {
  await vi.runAllTimersAsync()
  await promise
}

describe('sendBatch retry rules', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const cfg = (fetchImpl: unknown, onError = vi.fn()) => ({
    ingestUrl: 'http://pulse.test/',
    writeKey: 'lump_k',
    fetchImpl: fetchImpl as typeof fetch,
    onError,
  })

  it('does not retry on success', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }))
    const c = cfg(fetchMock)
    await run(sendBatch([event(1)], c))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(c.onError).not.toHaveBeenCalled()
  })

  it.each([500, 502, 503, 429])('retries once on HTTP %i and succeeds', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(status))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    const c = cfg(fetchMock)
    await run(sendBatch([event(1)], c))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(c.onError).not.toHaveBeenCalled()
  })

  it('retries once on a network error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    const c = cfg(fetchMock)
    await run(sendBatch([event(1)], c))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(c.onError).not.toHaveBeenCalled()
  })

  it('drops after the second failure and reports the server code', async () => {
    const fetchMock = vi.fn(async () => errorResponse(503))
    const c = cfg(fetchMock)
    await run(sendBatch([event(1), event(2)], c))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(c.onError).toHaveBeenCalledTimes(1)
    const err = c.onError.mock.calls[0]![0] as LumenPulseError
    expect(err).toBeInstanceOf(LumenPulseError)
    expect(err.status).toBe(503)
    expect(err.dropped).toBe(2)
  })

  it('reports status 0 after two network errors', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const c = cfg(fetchMock)
    await run(sendBatch([event(1)], c))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((c.onError.mock.calls[0]![0] as LumenPulseError).status).toBe(0)
  })

  it.each([
    [400, 'PULSE_BATCH_TOO_LARGE'],
    [401, 'PULSE_AUTH_INVALID'],
    [403, 'PULSE_ORIGIN_FORBIDDEN'],
    [404, undefined],
    [413, undefined],
    [422, 'PULSE_PII_PROPERTY_FORBIDDEN'],
  ])('never retries HTTP %i', async (status, code) => {
    const fetchMock = vi.fn(async () => errorResponse(status, code))
    const c = cfg(fetchMock)
    await run(sendBatch([event(1)], c))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const err = c.onError.mock.calls[0]![0] as LumenPulseError
    expect(err.status).toBe(status)
    expect(err.code).toBe(code)
  })

  it('waits for Retry-After before retrying a 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, 'PULSE_RATE_LIMITED', { 'retry-after': '3' }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    const c = cfg(fetchMock)
    const p = sendBatch([event(1)], c)
    await vi.advanceTimersByTimeAsync(2900)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await p
    expect(c.onError).not.toHaveBeenCalled()
  })

  it('drops without retrying when Retry-After exceeds the cap', async () => {
    const fetchMock = vi.fn(async () =>
      errorResponse(429, 'PULSE_RATE_LIMITED', { 'retry-after': '120' }),
    )
    const c = cfg(fetchMock)
    await run(sendBatch([event(1)], c))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((c.onError.mock.calls[0]![0] as LumenPulseError).code).toBe('PULSE_RATE_LIMITED')
  })

  it('never retries a spent monthly quota (429 PULSE_QUOTA_EXCEEDED)', async () => {
    const fetchMock = vi.fn(async () => errorResponse(429, 'PULSE_QUOTA_EXCEEDED'))
    const c = cfg(fetchMock)
    await run(sendBatch([event(1)], c))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((c.onError.mock.calls[0]![0] as LumenPulseError).code).toBe('PULSE_QUOTA_EXCEEDED')
  })

  it('sends keepalive and the key headers', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }))
    await run(sendBatch([event(1)], cfg(fetchMock)))
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://pulse.test/api/product/ingest/batch')
    expect(init.keepalive).toBe(true)
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('lump_k')
  })
})

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
    const now = Date.parse('2026-10-22T00:00:00Z')
    expect(parseRetryAfter('Thu, 22 Oct 2026 00:00:04 GMT', now)).toBe(4000)
  })
})

describe('chunkEvents', () => {
  it('splits by event count', () => {
    const events = Array.from({ length: 120 }, (_, i) => event(i))
    const chunks = chunkEvents(events, 50)
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20])
  })

  it('keeps every request body under the keepalive budget', () => {
    const big = 'x'.repeat(10_000)
    const events = Array.from({ length: 20 }, (_, i) => event(i, big))
    const chunks = chunkEvents(events, 50)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flat()).toHaveLength(20)
    for (const chunk of chunks) {
      const bytes = new TextEncoder().encode(JSON.stringify({ events: chunk })).length
      expect(bytes).toBeLessThanOrEqual(MAX_BODY_BYTES)
    }
  })
})
