import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLumenPulse } from '../src/index.js'
import { CONSENT_KEY, SESSION_KEY, memoryStorage } from '../src/storage.js'
import type { LumenPulseClient, LumenPulseConfig, PulseEvent } from '../src/types.js'

const clients: LumenPulseClient[] = []

function okFetch() {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 201 }))
}

function make(overrides: Partial<LumenPulseConfig> = {}) {
  const fetchMock = okFetch()
  const pulse = createLumenPulse({
    writeKey: 'lump_test',
    project: 'my-app',
    ingestUrl: 'http://pulse.test',
    storage: memoryStorage(),
    consent: 'granted',
    flushIntervalMs: 60_000,
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides,
  })
  clients.push(pulse)
  return { pulse, fetchMock }
}

function sentEvents(fetchMock: ReturnType<typeof okFetch>): PulseEvent[] {
  return fetchMock.mock.calls.flatMap(
    ([, init]) => (JSON.parse(String(init?.body)) as { events: PulseEvent[] }).events,
  )
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  localStorage.clear()
})

afterEach(async () => {
  while (clients.length) await clients.pop()!.shutdown()
  setVisibility('visible')
  vi.restoreAllMocks()
})

describe('unload flush', () => {
  it('sends the queue with keepalive on pagehide', () => {
    const { pulse, fetchMock } = make()
    pulse.track('clicked')
    window.dispatchEvent(new Event('pagehide'))
    // The request must start synchronously, before the page is gone.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1]?.keepalive).toBe(true)
    expect(sentEvents(fetchMock).map((e) => e.event_name)).toEqual(['clicked'])
  })

  it('flushes when the tab becomes hidden, not when it becomes visible', () => {
    const { pulse, fetchMock } = make()
    pulse.track('a')
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fetchMock).not.toHaveBeenCalled()
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('splits a large queue into requests under the keepalive budget', () => {
    const { pulse, fetchMock } = make({ maxBatchSize: 50 })
    const big = 'x'.repeat(5_000)
    // track() flushes on its own at 50; stay under it
    for (let i = 0; i < 30; i++) pulse.track('big', { big })
    window.dispatchEvent(new Event('pagehide'))
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    for (const [, init] of fetchMock.mock.calls) {
      expect(new TextEncoder().encode(String(init?.body)).length).toBeLessThanOrEqual(64 * 1024)
    }
    expect(sentEvents(fetchMock)).toHaveLength(30)
  })

  it('removes its listeners on shutdown', async () => {
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const removeDocument = vi.spyOn(document, 'removeEventListener')
    const { pulse } = make()
    await pulse.shutdown()
    expect(removeWindow).toHaveBeenCalledWith('pagehide', expect.any(Function))
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })
})

describe('context.path privacy', () => {
  it('sends the pathname without the query string by default', async () => {
    window.history.replaceState(null, '', '/checkout?token=secret&utm_source=ads&ref=x#top')
    const { pulse, fetchMock } = make()
    pulse.track('viewed')
    await pulse.flush()
    const [ev] = sentEvents(fetchMock)
    expect(ev!.context.path).toBe('/checkout')
    // UTMs still travel in their own field
    expect(ev!.context.utm).toEqual({ utm_source: 'ads' })
  })

  it('keeps only allowlisted params, with prefix globs', async () => {
    window.history.replaceState(
      null,
      '',
      '/checkout?token=secret&utm_source=ads&utm_medium=cpc&ref=x&reference=y',
    )
    const { pulse, fetchMock } = make({ includeQueryParams: ['utm_*', 'ref'] })
    pulse.track('viewed')
    await pulse.flush()
    expect(sentEvents(fetchMock)[0]!.context.path).toBe(
      '/checkout?utm_source=ads&utm_medium=cpc&ref=x',
    )
  })
})

describe('session_id and consent', () => {
  it('keeps session_id in memory until consent is granted', () => {
    const storage = memoryStorage()
    const { pulse } = make({ storage, consent: 'unknown' })
    expect(pulse.getSessionId()).toMatch(/^[0-9a-f-]{36}$/)
    expect(storage.getItem(SESSION_KEY)).toBeNull()

    const sessionBefore = pulse.getSessionId()
    pulse.setConsent('granted')
    expect(storage.getItem(SESSION_KEY)).toBe(sessionBefore)
    expect(pulse.getSessionId()).toBe(sessionBefore)

    pulse.setConsent('denied')
    expect(storage.getItem(SESSION_KEY)).toBeNull()
  })

  it('reset() before consent does not write a session', () => {
    const storage = memoryStorage()
    const { pulse } = make({ storage, consent: 'unknown' })
    pulse.reset()
    expect(storage.getItem(SESSION_KEY)).toBeNull()
  })

  it('leaves no lumen_pulse.* keys in localStorage except consent before grant', () => {
    const { pulse } = make({ storage: undefined, consent: 'unknown' })
    pulse.track('ignored')
    pulse.setConsent('unknown')
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('lumen_pulse.'))
    expect(keys).toEqual([CONSENT_KEY])
  })

  it('reuses a persisted session after consent was granted earlier', () => {
    const storage = memoryStorage()
    storage.setItem(CONSENT_KEY, 'granted')
    storage.setItem(SESSION_KEY, 'persisted-session')
    storage.setItem('lumen_pulse.session_start', String(Date.now() - 60_000))
    storage.setItem('lumen_pulse.session_last', String(Date.now() - 1_000))
    const { pulse } = make({ storage, consent: 'unknown' })
    expect(pulse.getSessionId()).toBe('persisted-session')
  })
})

describe('SPA page views', () => {
  it('tracks page_view on history navigation, deduplicated by path', async () => {
    const { pulse, fetchMock } = make({ autocapture: { pageViews: 'history' } })
    window.history.pushState(null, '', '/a')
    window.history.pushState(null, '', '/a') // same path
    window.history.replaceState({ step: 2 }, '', '/a?tab=2') // query not part of path
    window.history.pushState(null, '', '/b')
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }))
    window.history.back()
    await popped
    await pulse.flush()
    const views = sentEvents(fetchMock).filter((e) => e.event_name === 'page_view')
    expect(views.map((e) => e.context.path)).toEqual(['/', '/a', '/b', '/a'])
  })

  it('stops tracking and unpatches history on shutdown', async () => {
    const originalPush = window.history.pushState
    const { pulse, fetchMock } = make({ autocapture: { pageViews: 'history' } })
    expect(window.history.pushState).not.toBe(originalPush)
    await pulse.shutdown()
    expect(window.history.pushState).toBe(originalPush)
    fetchMock.mockClear()
    window.history.pushState(null, '', '/after')
    await pulse.flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps autocapturePageViews: true as a single boot page_view', async () => {
    const originalPush = window.history.pushState
    const { pulse, fetchMock } = make({ autocapturePageViews: true })
    expect(window.history.pushState).toBe(originalPush)
    window.history.pushState(null, '', '/next')
    await pulse.flush()
    expect(sentEvents(fetchMock).map((e) => e.event_name)).toEqual(['page_view'])
  })
})
