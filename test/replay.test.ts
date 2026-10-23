import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLumenPulse } from '../src/index.js'
import { REPLAY_KEY, resolveReplayOptions, type RecordOptions, type RrwebEvent } from '../src/replay.js'
import { memoryStorage, type StorageLike } from '../src/storage.js'
import type { LumenPulseClient, LumenPulseConfig, PulseEvent, ReplayChunk } from '../src/types.js'

const rr = vi.hoisted(() => ({
  options: [] as RecordOptions[],
  stops: [] as Array<ReturnType<typeof vi.fn>>,
}))

vi.mock('rrweb', () => ({
  record: vi.fn((options: RecordOptions) => {
    rr.options.push(options)
    const stop = vi.fn()
    rr.stops.push(stop)
    return stop
  }),
}))

const clients: LumenPulseClient[] = []
const T0 = Date.parse('2026-10-22T23:00:00.000Z')

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>

function okFetch(): FetchMock {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"accepted":true}', { status: 200 }))
}

function make(overrides: Partial<LumenPulseConfig> = {}, fetchMock: FetchMock = okFetch()) {
  const storage = (overrides.storage as StorageLike | undefined) ?? memoryStorage()
  const pulse = createLumenPulse({
    writeKey: 'lump_test',
    project: 'dpwai-spaces',
    ingestUrl: 'http://pulse.test/',
    consent: 'granted',
    flushIntervalMs: 60_000,
    replay: { sampleRate: 1 },
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides,
    storage,
  })
  clients.push(pulse)
  return { pulse, fetchMock, storage }
}

/** Let the lazy import and the rrweb start resolve. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/** The latest recorder's emit. */
function emit(event: RrwebEvent, isCheckout?: boolean) {
  rr.options[rr.options.length - 1]!.emit(event, isCheckout)
}

function ev(ts: number, type = 3, data: unknown = { source: 2 }): RrwebEvent {
  return { type, timestamp: T0 + ts, data }
}

function replayCalls(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/product/replay/chunk'))
}

function chunks(fetchMock: FetchMock): ReplayChunk[] {
  return replayCalls(fetchMock).map(([, init]) => JSON.parse(String(init?.body)) as ReplayChunk)
}

function decode(chunk: ReplayChunk): RrwebEvent[] {
  return JSON.parse(gunzipSync(Buffer.from(chunk.data, 'base64')).toString('utf8')) as RrwebEvent[]
}

/** Text that gzip cannot shrink much. */
function noise(chars: number): string {
  let out = ''
  while (out.length < chars) out += Math.random().toString(36).slice(2)
  return out.slice(0, chars)
}

beforeEach(() => {
  rr.options.length = 0
  rr.stops.length = 0
  window.history.replaceState(null, '', '/spaces?token=secret#access_token=x')
})

afterEach(async () => {
  while (clients.length) await clients.pop()!.shutdown()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('options', () => {
  it('is off unless configured', () => {
    expect(resolveReplayOptions(undefined)).toBeNull()
    expect(resolveReplayOptions(false)).toBeNull()
  })

  it('applies the documented defaults', () => {
    expect(resolveReplayOptions(true)).toEqual({
      sampleRate: 0.1,
      onErrorSampleRate: 1,
      bufferMs: 60_000,
      maskAllText: true,
      maskAllInputs: true,
      blockSelector: '[data-private]',
      maxChunkBytes: 45_000,
      maskLevel: 'all',
    })
  })

  it('derives mask_level from the masks', () => {
    expect(resolveReplayOptions({ maskAllText: false })!.maskLevel).toBe('inputs')
    expect(resolveReplayOptions({ maskAllText: false, maskAllInputs: false })!.maskLevel).toBe('none')
    // Masking all text also masks inputs, so this is still `all`.
    const textOnly = resolveReplayOptions({ maskAllInputs: false })!
    expect(textOnly.maskLevel).toBe('all')
    expect(textOnly.maskAllInputs).toBe(true)
  })

  it('clamps rates and caps maxChunkBytes at the server limit', () => {
    const o = resolveReplayOptions({ sampleRate: 3, onErrorSampleRate: -1, maxChunkBytes: 10_000_000 })!
    expect(o.sampleRate).toBe(1)
    expect(o.onErrorSampleRate).toBe(0)
    expect(o.maxChunkBytes).toBe(512 * 1024)
  })
})

describe('masking passed to rrweb', () => {
  it('masks all text and inputs and blocks [data-private] by default', async () => {
    make()
    await settle()
    expect(rr.options).toHaveLength(1)
    const { emit: _emit, ...opts } = rr.options[0]!
    expect(opts).toEqual({ maskAllInputs: true, maskTextSelector: '*', blockSelector: '[data-private]' })
  })

  it('honours explicit masks and blockSelector', async () => {
    make({ replay: { sampleRate: 1, maskAllText: false, blockSelector: '.secret' } })
    await settle()
    const { emit: _emit, ...opts } = rr.options[0]!
    expect(opts).toEqual({ maskAllInputs: true, blockSelector: '.secret' })
  })

  it('sends mask_level none only when both masks are off', async () => {
    const { pulse, fetchMock } = make({
      replay: { sampleRate: 1, maskAllText: false, maskAllInputs: false },
    })
    await settle()
    expect(rr.options[0]!.maskAllInputs).toBe(false)
    expect(rr.options[0]!.maskTextSelector).toBeUndefined()
    emit(ev(0))
    await pulse.flush()
    expect(chunks(fetchMock)[0]!.mask_level).toBe('none')
  })

  it('sends mask_level inputs when only inputs are masked', async () => {
    const { pulse, fetchMock } = make({ replay: { sampleRate: 1, maskAllText: false } })
    await settle()
    emit(ev(0))
    await pulse.flush()
    expect(chunks(fetchMock)[0]!.mask_level).toBe('inputs')
  })
})

describe('consent and support', () => {
  it('records nothing before consent and starts on grant', async () => {
    const { pulse, storage } = make({ consent: 'unknown' })
    await settle()
    expect(rr.options).toHaveLength(0)
    expect(storage.getItem(REPLAY_KEY)).toBeNull()
    pulse.setConsent('granted')
    await settle()
    expect(rr.options).toHaveLength(1)
  })

  it('stops, drops buffers and forgets the decision when consent is denied', async () => {
    const { pulse, fetchMock, storage } = make()
    await settle()
    emit(ev(0, 4, { href: 'https://app.test/', width: 1, height: 1 }))
    emit(ev(10))
    pulse.setConsent('denied')
    expect(rr.stops[0]).toHaveBeenCalledTimes(1)
    expect(storage.getItem(REPLAY_KEY)).toBeNull()
    await pulse.flush()
    expect(replayCalls(fetchMock)).toHaveLength(0)
  })

  it('skips replay entirely without CompressionStream', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    make()
    await settle()
    expect(rr.options).toHaveLength(0)
  })

  it('does not load rrweb when replay is off', async () => {
    make({ replay: false })
    await settle()
    expect(rr.options).toHaveLength(0)
  })
})

describe('sampling decision', () => {
  it('streams a sampled session and stores the decision with the session id', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.05)
    const { pulse, storage } = make({ replay: { sampleRate: 0.1 } })
    await settle()
    const state = JSON.parse(storage.getItem(REPLAY_KEY)!) as { s: string; m: string }
    expect(state.s).toBe(pulse.getSessionId())
    expect(state.m).toBe('stream')
    expect(rr.options[0]!.checkoutEveryNms).toBeUndefined()
  })

  it('buffers an unsampled session with a checkout every half window', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { storage } = make({ replay: { sampleRate: 0.1 } })
    await settle()
    expect(JSON.parse(storage.getItem(REPLAY_KEY)!).m).toBe('buffer')
    expect(rr.options[0]!.checkoutEveryNms).toBe(30_000)
  })

  it('keeps the decision for the same session across page loads', async () => {
    const storage = memoryStorage()
    vi.spyOn(Math, 'random').mockReturnValue(0.05)
    const first = make({ storage, replay: { sampleRate: 0.1 } })
    await settle()
    await first.pulse.shutdown()
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const second = make({ storage, replay: { sampleRate: 0.1 } })
    await settle()
    expect(second.pulse.getSessionId()).toBe(first.pulse.getSessionId())
    expect(rr.options[1]!.checkoutEveryNms).toBeUndefined() // still streaming
  })

  it('makes a new decision after reset()', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.05)
    const { pulse, fetchMock, storage } = make({ replay: { sampleRate: 0.1 } })
    await settle()
    const oldSession = pulse.getSessionId()
    pulse.identify('user-1')
    emit(ev(0))
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    pulse.reset()
    await settle()
    expect(rr.stops[0]).toHaveBeenCalled()
    const state = JSON.parse(storage.getItem(REPLAY_KEY)!) as { s: string; m: string }
    expect(state.s).toBe(pulse.getSessionId())
    expect(state.s).not.toBe(oldSession)
    expect(state.m).toBe('buffer')
    await pulse.flush()
    // the pending chunk went out under the old session and user
    const [chunk] = chunks(fetchMock)
    expect(chunk!.session_id).toBe(oldSession)
    expect(chunk!.user_id).toBe('user-1')
  })
})

describe('streaming chunks', () => {
  it('posts the contract payload with seq per session', async () => {
    const { pulse, fetchMock } = make()
    await settle()
    emit(ev(0, 4, { href: 'https://app.test/spaces?token=secret#access_token=x', width: 800, height: 600 }), false)
    emit(ev(10, 2, { node: {} }))
    emit(ev(2_500))
    await pulse.flush()
    emit(ev(12_000))
    await pulse.flush()

    const calls = replayCalls(fetchMock)
    expect(calls).toHaveLength(2)
    const [url, init] = calls[0]!
    expect(url).toBe('http://pulse.test/api/product/replay/chunk')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('lump_test')

    const [first, second] = chunks(fetchMock)
    expect(Object.keys(first!).sort()).toEqual(
      [
        'anonymous_id',
        'data',
        'ended_at',
        'has_error',
        'mask_level',
        'project',
        'seq',
        'session_id',
        'started_at',
        'trigger',
        'user_id',
      ].sort(),
    )
    expect(first).toMatchObject({
      project: 'dpwai-spaces',
      session_id: pulse.getSessionId(),
      seq: 0,
      started_at: '2026-10-22T23:00:00.000Z',
      ended_at: '2026-10-22T23:00:02.500Z',
      mask_level: 'all',
      trigger: 'sampled',
      has_error: false,
      user_id: '',
      anonymous_id: pulse.getAnonymousId(),
    })
    const events = decode(first!)
    expect(events.map((e) => e.type)).toEqual([4, 2, 3])
    // the recorded URL loses its query string and fragment
    expect((events[0]!.data as { href: string }).href).toBe('https://app.test/spaces')
    expect(second!.seq).toBe(1)
    expect(decode(second!)).toHaveLength(1)
  })

  it('stamps user_id after identify()', async () => {
    const { pulse, fetchMock } = make()
    await settle()
    pulse.identify('user-42')
    emit(ev(0))
    await pulse.flush()
    expect(chunks(fetchMock)[0]!.user_id).toBe('user-42')
  })

  it('continues seq across page loads of the same session', async () => {
    const storage = memoryStorage()
    const a = make({ storage })
    await settle()
    emit(ev(0))
    await a.pulse.shutdown()
    const b = make({ storage })
    await settle()
    emit(ev(1))
    await b.pulse.flush()
    expect(chunks(a.fetchMock)[0]!.seq).toBe(0)
    expect(chunks(b.fetchMock)[0]!.seq).toBe(1)
  })

  it('uploads every 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { fetchMock } = make()
    await settle()
    emit(ev(0))
    expect(replayCalls(fetchMock)).toHaveLength(0)
    vi.advanceTimersByTime(10_000)
    await settle()
    expect(replayCalls(fetchMock)).toHaveLength(1)
  })

  it('splits so each chunk stays within maxChunkBytes', async () => {
    const { pulse, fetchMock } = make({ replay: { sampleRate: 1, maxChunkBytes: 2_000 } })
    await settle()
    for (let i = 0; i < 20; i++) emit(ev(i, 3, { text: noise(500) }))
    await pulse.flush()
    const sent = chunks(fetchMock)
    expect(sent.length).toBeGreaterThan(2)
    expect(sent.map((c) => c.seq)).toEqual(sent.map((_, i) => i))
    for (const c of sent) expect(Buffer.from(c.data, 'base64').length).toBeLessThanOrEqual(2_000)
    expect(sent.flatMap((c) => decode(c)).map((e) => e.timestamp)).toEqual(
      Array.from({ length: 20 }, (_, i) => T0 + i),
    )
  })

  it('uses keepalive only for bodies up to 60 KB', async () => {
    const { pulse, fetchMock } = make({ replay: { sampleRate: 1, maxChunkBytes: 200_000 } })
    await settle()
    emit(ev(0))
    await pulse.flush()
    emit(ev(1, 3, { text: noise(90_000) }))
    await pulse.flush()
    const calls = replayCalls(fetchMock)
    expect(String(calls[0]![1]!.body).length).toBeLessThan(60 * 1024)
    expect(calls[0]![1]!.keepalive).toBe(true)
    expect(String(calls[1]![1]!.body).length).toBeGreaterThan(60 * 1024)
    expect(calls[1]![1]!.keepalive).toBe(false)
  })

  it('flushes when the page is hidden', async () => {
    const { fetchMock } = make()
    await settle()
    emit(ev(0))
    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(replayCalls(fetchMock)).toHaveLength(1)
  })

  it('stops rrweb and flushes on shutdown', async () => {
    const { pulse, fetchMock } = make()
    await settle()
    emit(ev(0))
    await pulse.shutdown()
    expect(rr.stops[0]).toHaveBeenCalledTimes(1)
    expect(replayCalls(fetchMock)).toHaveLength(1)
  })
})

describe('error-triggered upload', () => {
  function bufferClient(overrides: Partial<LumenPulseConfig> = {}) {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    return make({ captureErrors: true, replay: { sampleRate: 0.1 }, ...overrides })
  }

  it('uploads nothing while buffering', async () => {
    const { pulse, fetchMock } = bufferClient()
    await settle()
    emit(ev(0))
    await pulse.flush()
    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(replayCalls(fetchMock)).toHaveLength(0)
  })

  it('keeps only the checkouts covering the last bufferSeconds', async () => {
    const { pulse, fetchMock } = bufferClient()
    await settle()
    for (const start of [0, 30_000, 60_000, 90_000]) {
      emit(ev(start, 4, { href: 'https://app.test/', width: 1, height: 1 }), true)
      emit(ev(start + 1, 2, { node: {} }))
      emit(ev(start + 5_000))
    }
    emit(ev(95_000))
    pulse.captureException(new Error('boom'))
    await pulse.flush()
    const [chunk] = chunks(fetchMock)
    const events = decode(chunk!)
    // cutoff 35 s: the checkout at 30 s is the newest at or before it
    expect(events[0]!.timestamp).toBe(T0 + 30_000)
    expect(events[0]!.type).toBe(4)
    expect(events[events.length - 1]!.timestamp).toBe(T0 + 95_000)
    expect(events).toHaveLength(10)
  })

  it('uploads the buffer on an error and streams the rest of the session', async () => {
    const { pulse, fetchMock, storage } = bufferClient()
    await settle()
    emit(ev(0, 4, { href: 'https://app.test/', width: 1, height: 1 }))
    emit(ev(1, 2, { node: {} }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'kaboom', error: new Error('kaboom') }))
    await settle()

    // the recorder restarted without checkouts
    expect(rr.stops[0]).toHaveBeenCalledTimes(1)
    expect(rr.options).toHaveLength(2)
    expect(rr.options[1]!.checkoutEveryNms).toBeUndefined()
    expect(JSON.parse(storage.getItem(REPLAY_KEY)!)).toMatchObject({ m: 'stream', t: 'error' })

    emit(ev(2_000, 4, { href: 'https://app.test/', width: 1, height: 1 }))
    await pulse.flush()
    const sent = chunks(fetchMock)
    expect(sent.map((c) => [c.seq, c.trigger, c.has_error])).toEqual([
      [0, 'error', true],
      [1, 'error', true],
    ])
    expect(decode(sent[0]!).map((e) => e.timestamp)).toEqual([T0, T0 + 1])

    // the $exception carries the same session_id, so the error links to the replay
    const exceptions = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/ingest/batch'))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: PulseEvent[] }).events)
      .filter((e) => e.event_name === '$exception')
    expect(exceptions[0]!.session_id).toBe(sent[0]!.session_id)
  })

  it('rolls onErrorSampleRate once per session', async () => {
    const { pulse, fetchMock } = bufferClient({ replay: { sampleRate: 0.1, onErrorSampleRate: 0.2 } })
    await settle()
    emit(ev(0))
    pulse.captureException(new Error('one')) // random 0.5 >= 0.2: not uploaded
    vi.spyOn(Math, 'random').mockReturnValue(0)
    pulse.captureException(new Error('two'))
    await pulse.flush()
    expect(replayCalls(fetchMock)).toHaveLength(0)
    expect(rr.options).toHaveLength(1)
  })

  it('marks a sampled session has_error after an error', async () => {
    const { pulse, fetchMock } = make({ captureErrors: true })
    await settle()
    emit(ev(0))
    await pulse.flush()
    emit(ev(1))
    pulse.captureException(new Error('boom'))
    await pulse.flush()
    expect(chunks(fetchMock).map((c) => [c.trigger, c.has_error])).toEqual([
      ['sampled', false],
      ['sampled', true],
    ])
  })
})

describe('server rejections', () => {
  function rejecting(status: number, code: string) {
    return vi.fn(async (url: string) =>
      url.endsWith('/replay/chunk')
        ? new Response(JSON.stringify({ code }), { status })
        : new Response(null, { status: 201 }),
    ) as unknown as FetchMock
  }

  it.each([
    [403, 'REPLAY_NOT_ENABLED'],
    [429, 'REPLAY_QUOTA_EXCEEDED'],
  ])('stops recording on %i %s without retrying', async (status, code) => {
    const onError = vi.fn()
    const fetchMock = rejecting(status, code)
    const { pulse } = make({ onError }, fetchMock)
    await settle()
    emit(ev(0))
    await pulse.flush()
    expect(replayCalls(fetchMock)).toHaveLength(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toMatchObject({ status, code })
    expect(rr.stops[0]).toHaveBeenCalledTimes(1)
    emit(ev(1))
    await pulse.flush()
    expect(replayCalls(fetchMock)).toHaveLength(1)
  })

  it('retries once on 5xx', async () => {
    const fetchMock = vi
      .fn(async (_url: string, _init?: RequestInit) => new Response('{"accepted":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'retry-after': '0' } }))
    const onError = vi.fn()
    const { pulse } = make({ onError }, fetchMock)
    await settle()
    emit(ev(0))
    await pulse.flush()
    expect(replayCalls(fetchMock)).toHaveLength(2)
    expect(onError).not.toHaveBeenCalled()
  })
})
