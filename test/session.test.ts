import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLumenPulse } from '../src/index.js'
import { REPLAY_KEY, type RecordOptions, type RrwebEvent } from '../src/replay.js'
import { SESSION_LAST_KEY, SESSION_START_KEY } from '../src/session.js'
import { SESSION_KEY, memoryStorage, type StorageLike } from '../src/storage.js'
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

const MIN = 60_000
const T0 = Date.parse('2026-10-22T12:00:00.000Z')
let now = T0
const clients: LumenPulseClient[] = []

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>

function okFetch(): FetchMock {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"accepted":true}', { status: 200 }))
}

function make(overrides: Partial<LumenPulseConfig> = {}, fetchMock: FetchMock = okFetch()) {
  const storage = (overrides.storage as StorageLike | undefined) ?? memoryStorage()
  const pulse = createLumenPulse({
    writeKey: 'lump_test',
    project: 'p',
    ingestUrl: 'http://pulse.test',
    consent: 'granted',
    flushIntervalMs: 60_000,
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides,
    storage,
  })
  clients.push(pulse)
  return { pulse, fetchMock, storage }
}

function events(fetchMock: FetchMock): PulseEvent[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/ingest/batch'))
    .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: PulseEvent[] }).events)
}

function chunks(fetchMock: FetchMock): ReplayChunk[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/replay/chunk'))
    .map(([, init]) => JSON.parse(String(init?.body)) as ReplayChunk)
}

function emit(event: RrwebEvent) {
  rr.options[rr.options.length - 1]!.emit(event)
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  now = T0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  rr.options.length = 0
  rr.stops.length = 0
})

afterEach(async () => {
  while (clients.length) await clients.pop()!.shutdown()
  vi.restoreAllMocks()
})

describe('idle rotation', () => {
  it('starts a new session after 30 idle minutes', async () => {
    const { pulse, fetchMock, storage } = make()
    pulse.track('a')
    const first = pulse.getSessionId()
    now += 31 * MIN
    pulse.track('b')
    expect(pulse.getSessionId()).not.toBe(first)
    expect(storage.getItem(SESSION_KEY)).toBe(pulse.getSessionId())
    expect(storage.getItem(SESSION_START_KEY)).toBe(String(now))
    await pulse.flush()
    expect(events(fetchMock).map((e) => e.session_id)).toEqual([first, pulse.getSessionId()])
  })

  it('keeps the session while activity continues inside the window', () => {
    const { pulse } = make()
    const first = pulse.getSessionId()
    for (let i = 0; i < 6; i++) {
      now += 20 * MIN
      pulse.track('tick')
    }
    expect(pulse.getSessionId()).toBe(first)
  })

  it('honours sessionTimeoutMinutes', () => {
    const { pulse } = make({ sessionTimeoutMinutes: 5 })
    const first = pulse.getSessionId()
    now += 4 * MIN
    pulse.track('a')
    expect(pulse.getSessionId()).toBe(first)
    now += 6 * MIN
    pulse.track('b')
    expect(pulse.getSessionId()).not.toBe(first)
  })

  it('rotates at sessionMaxHours even while active', () => {
    const { pulse } = make({ sessionMaxHours: 1 })
    const ids = new Set<string>()
    for (let i = 0; i <= 7; i++) {
      pulse.track('tick')
      ids.add(pulse.getSessionId())
      now += 10 * MIN
    }
    expect(ids.size).toBe(2) // rotated once, after 60 minutes
  })

  it('rotates when the tab becomes visible after the timeout', () => {
    const { pulse } = make()
    const first = pulse.getSessionId()
    now += 45 * MIN
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(pulse.getSessionId()).not.toBe(first)
  })
})

describe('session on start', () => {
  it('resumes a stored session that is still active', () => {
    const storage = memoryStorage()
    const a = make({ storage })
    a.pulse.track('x')
    now += 10 * MIN
    const b = make({ storage })
    expect(b.pulse.getSessionId()).toBe(a.pulse.getSessionId())
  })

  it('starts fresh when the stored session went idle', () => {
    const storage = memoryStorage()
    const a = make({ storage })
    a.pulse.track('x')
    now += 31 * MIN
    const b = make({ storage })
    expect(b.pulse.getSessionId()).not.toBe(a.pulse.getSessionId())
  })

  it('replaces a session stored without times (v0.3)', () => {
    const storage = memoryStorage()
    storage.setItem('lumen_pulse.consent', 'granted')
    storage.setItem(SESSION_KEY, 'old-forever-session')
    const { pulse } = make({ storage })
    expect(pulse.getSessionId()).not.toBe('old-forever-session')
    expect(storage.getItem(SESSION_LAST_KEY)).toBe(String(T0))
  })

  it('follows a newer session another tab started', () => {
    const storage = memoryStorage()
    const a = make({ storage })
    const b = make({ storage })
    expect(b.pulse.getSessionId()).toBe(a.pulse.getSessionId())
    now += 40 * MIN
    a.pulse.track('back') // tab A rotates
    now += MIN
    b.pulse.track('also back') // tab B adopts A's new session instead of making a third
    expect(b.pulse.getSessionId()).toBe(a.pulse.getSessionId())
  })
})

describe('consent', () => {
  it('keeps session times in memory before consent and persists them on grant', () => {
    const { pulse, storage } = make({ consent: 'unknown' })
    pulse.track('dropped')
    now += 31 * MIN
    const before = pulse.getSessionId()
    pulse.track('dropped') // rotates in memory only
    expect(pulse.getSessionId()).not.toBe(before)
    expect(storage.getItem(SESSION_KEY)).toBeNull()
    expect(storage.getItem(SESSION_LAST_KEY)).toBeNull()
    expect(storage.getItem(SESSION_START_KEY)).toBeNull()
    pulse.setConsent('granted')
    expect(storage.getItem(SESSION_KEY)).toBe(pulse.getSessionId())
    expect(storage.getItem(SESSION_LAST_KEY)).toBe(String(now))
    pulse.setConsent('denied')
    expect(storage.getItem(SESSION_KEY)).toBeNull()
    expect(storage.getItem(SESSION_LAST_KEY)).toBeNull()
    expect(storage.getItem(SESSION_START_KEY)).toBeNull()
  })
})

describe('per-session state', () => {
  it('starts error dedup over in the new session', async () => {
    const { pulse, fetchMock } = make({ captureErrors: true })
    const err = new Error('same')
    pulse.captureException(err)
    pulse.captureException(err) // repeat: counted, not sent
    now += 31 * MIN
    pulse.captureException(err) // new session: sent again as a first occurrence
    await pulse.flush()
    const ex = events(fetchMock).filter((e) => e.event_name === '$exception')
    const firsts = ex.filter((e) => e.properties.count === 1)
    expect(firsts).toHaveLength(2)
    expect(firsts[0]!.session_id).not.toBe(firsts[1]!.session_id)
  })

  it('restarts replay for the new session: new decision, full snapshot, seq 0', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.05) // sampled
    const { pulse, fetchMock, storage } = make({ replay: { sampleRate: 0.1 } })
    await settle()
    const first = pulse.getSessionId()
    emit({ type: 4, timestamp: now, data: { href: 'https://app.test/', width: 1, height: 1 } })
    await pulse.flush()
    emit({ type: 3, timestamp: now, data: { source: 2 } })

    vi.spyOn(Math, 'random').mockReturnValue(0.99) // the new session is not sampled
    now += 31 * MIN
    pulse.track('back')
    await settle()

    expect(rr.stops[0]).toHaveBeenCalledTimes(1)
    expect(rr.options).toHaveLength(2) // a new recorder, so a new full snapshot
    expect(rr.options[1]!.checkoutEveryNms).toBe(30_000) // new decision: buffer
    const state = JSON.parse(storage.getItem(REPLAY_KEY)!) as { s: string; m: string; q: number }
    expect(state).toMatchObject({ s: pulse.getSessionId(), m: 'buffer', q: 0 })
    await pulse.flush()
    // the pending chunk went out under the old session
    expect(chunks(fetchMock).map((c) => [c.session_id, c.seq])).toEqual([
      [first, 0],
      [first, 1],
    ])
  })

  it('starts seq at 0 for the new session', async () => {
    const { pulse, fetchMock } = make({ replay: { sampleRate: 1 } })
    await settle()
    emit({ type: 3, timestamp: now, data: { source: 2 } })
    await pulse.flush()
    now += 31 * MIN
    pulse.track('back')
    await settle()
    emit({ type: 3, timestamp: now, data: { source: 2 } })
    await pulse.flush()
    const sent = chunks(fetchMock)
    expect(sent.map((c) => c.seq)).toEqual([0, 0])
    expect(sent[0]!.session_id).not.toBe(sent[1]!.session_id)
  })

  it('clears a server stop when the session rotates', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/replay/chunk')
        ? new Response('{"code":"REPLAY_QUOTA_EXCEEDED"}', { status: 429 })
        : new Response(null, { status: 201 }),
    ) as unknown as FetchMock
    const { pulse } = make({ replay: { sampleRate: 1 }, onError: () => {} }, fetchMock)
    await settle()
    emit({ type: 3, timestamp: now, data: { source: 2 } })
    await pulse.flush()
    expect(rr.stops[0]).toHaveBeenCalled()
    now += 31 * MIN
    pulse.track('back')
    await settle()
    expect(rr.options).toHaveLength(2)
  })
})

describe('replay activity', () => {
  it('user input keeps the session alive; DOM mutations alone do not', async () => {
    const { pulse } = make({ replay: { sampleRate: 1 } })
    await settle()
    const first = pulse.getSessionId()
    for (let i = 0; i < 3; i++) {
      now += 20 * MIN
      emit({ type: 3, timestamp: now, data: { source: 2 } }) // click
    }
    pulse.track('x')
    expect(pulse.getSessionId()).toBe(first)

    for (let i = 0; i < 3; i++) {
      now += 20 * MIN
      emit({ type: 3, timestamp: now, data: { source: 0 } }) // mutation
    }
    pulse.track('y')
    expect(pulse.getSessionId()).not.toBe(first)
  })

  it('rotates on the next tick when input arrives after the timeout', async () => {
    const { pulse } = make({ replay: { sampleRate: 1 } })
    await settle()
    const first = pulse.getSessionId()
    now += 31 * MIN
    emit({ type: 3, timestamp: now, data: { source: 2 } })
    expect(pulse.getSessionId()).toBe(first) // not inside rrweb's emit
    await settle()
    expect(pulse.getSessionId()).not.toBe(first)
    expect(rr.options).toHaveLength(2)
  })
})

describe('seq across tabs', () => {
  it('allocates seq from storage right before each upload', async () => {
    const storage = memoryStorage()
    const a = make({ storage, replay: { sampleRate: 1 } })
    const b = make({ storage, replay: { sampleRate: 1 } })
    await settle()
    expect(b.pulse.getSessionId()).toBe(a.pulse.getSessionId())
    const seqs: number[] = []
    for (const tab of [a, b, a, b]) {
      const options = rr.options[tab === a ? 0 : 1]!
      options.emit({ type: 3, timestamp: now, data: { source: 2 } })
      await tab.pulse.flush()
    }
    for (const c of [...chunks(a.fetchMock), ...chunks(b.fetchMock)]) {
      seqs.push(c.seq)
      expect(JSON.parse(gunzipSync(Buffer.from(c.data, 'base64')).toString())).toHaveLength(1)
    }
    expect(seqs.sort()).toEqual([0, 1, 2, 3])
  })
})
