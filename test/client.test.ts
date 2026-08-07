import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLumenPulse } from '../src/index.js'
import { memoryStorage } from '../src/storage.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createLumenPulse', () => {
  it('requires writeKey, project, ingestUrl', () => {
    expect(() =>
      createLumenPulse({ writeKey: '', project: 'p', ingestUrl: 'http://x' }),
    ).toThrow(/writeKey/)
    expect(() =>
      createLumenPulse({ writeKey: 'k', project: '', ingestUrl: 'http://x' }),
    ).toThrow(/project/)
    expect(() =>
      createLumenPulse({ writeKey: 'k', project: 'p', ingestUrl: '' }),
    ).toThrow(/ingestUrl/)
  })

  it('does not persist anonymous_id until consent is granted', () => {
    const storage = memoryStorage()
    const pulse = createLumenPulse({
      writeKey: 'k',
      project: 'posto-regulado',
      ingestUrl: 'http://example.test',
      storage,
      consent: 'unknown',
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    })
    expect(pulse.getAnonymousId()).toBeNull()
    pulse.setConsent('granted')
    expect(pulse.getAnonymousId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  it('batches track + identity.alias and flushes to ingest', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    const storage = memoryStorage()
    const pulse = createLumenPulse({
      writeKey: 'wk_test',
      project: 'faladelivery',
      ingestUrl: 'http://pulse.test',
      storage,
      consent: 'granted',
      flushIntervalMs: 60_000,
      maxBatchSize: 50,
      fetch: fetchMock as unknown as typeof fetch,
    })

    pulse.track('page_view', { from: 'test' })
    pulse.identify('user-1', { plan: 'pro' })
    await pulse.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://pulse.test/api/product/ingest/batch')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body)) as {
      events: Array<{ event_name: string; user_id: string | null; signal_kind: string }>
    }
    expect(body.events).toHaveLength(2)
    expect(body.events[0]!.event_name).toBe('page_view')
    expect(body.events[0]!.signal_kind).toBe('product')
    expect(body.events[1]!.event_name).toBe('identity.alias')
    expect(body.events[1]!.user_id).toBe('user-1')
  })

  it('drops events when consent is not granted', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    for (const consent of ['denied', 'unknown'] as const) {
      fetchMock.mockClear()
      const pulse = createLumenPulse({
        writeKey: 'k',
        project: 'p',
        ingestUrl: 'http://x',
        storage: memoryStorage(),
        consent,
        fetch: fetchMock as unknown as typeof fetch,
      })
      pulse.track('page_view')
      await pulse.flush()
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })
})
