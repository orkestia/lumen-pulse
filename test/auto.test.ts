import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LumenPulseGlobal } from '../src/auto.js'
import type { RecordOptions } from '../src/replay.js'
import type { PulseEvent } from '../src/types.js'

const rr = vi.hoisted(() => ({ options: [] as RecordOptions[] }))

vi.mock('rrweb', () => ({
  record: vi.fn((options: RecordOptions) => {
    rr.options.push(options)
    return () => {}
  }),
}))

function addScript(attrs: Record<string, string>) {
  const el = document.createElement('script')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.head.appendChild(el)
  return el
}

async function boot(): Promise<LumenPulseGlobal> {
  vi.resetModules()
  await import('../src/auto.js')
  return window.LumenPulse!
}

describe('auto.ts boot', () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 201 }))

  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockClear()
    rr.options.length = 0
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(null, '', '/landing?utm_source=ads&token=secret')
  })

  afterEach(async () => {
    await window.LumenPulse?.client?.shutdown()
    delete window.LumenPulse
    document.head.querySelectorAll('script').forEach((s) => s.remove())
    vi.unstubAllGlobals()
  })

  it('creates a client from data-* attributes', async () => {
    addScript({
      'data-write-key': 'lump_test',
      'data-project': 'my-landing',
      'data-ingest-url': 'https://lumen-api.example',
      'data-consent': 'granted',
      'data-autocapture': 'history',
      'data-include-query-params': 'utm_*, ref',
      'data-organization-uuid': 'org-1',
    })
    const api = await boot()
    expect(api.client).not.toBeNull()
    expect(typeof api.create).toBe('function')
    window.history.pushState(null, '', '/pricing')
    await api.client!.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://lumen-api.example/api/product/ingest/batch')
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('lump_test')
    const events = (JSON.parse(String(init?.body)) as { events: PulseEvent[] }).events
    expect(events.map((e) => [e.event_name, e.context.path])).toEqual([
      ['page_view', '/landing?utm_source=ads'],
      ['page_view', '/pricing'],
    ])
    expect(events[0]!.project).toBe('my-landing')
    expect(events[0]!.organization_uuid).toBe('org-1')
  })

  it('leaves client null without the required attributes', async () => {
    addScript({ 'data-write-key': 'lump_test', 'data-project': 'my-landing' })
    const api = await boot()
    expect(api.client).toBeNull()
  })

  it('stays silent until consent when data-consent is absent', async () => {
    addScript({
      'data-write-key': 'lump_test',
      'data-project': 'my-landing',
      'data-ingest-url': 'https://lumen-api.example',
      'data-autocapture': 'true',
    })
    const api = await boot()
    await api.client!.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(Object.keys(localStorage).filter((k) => k.startsWith('lumen_pulse.'))).toEqual([])
  })

  it('captures uncaught errors with data-capture-errors="true"', async () => {
    addScript({
      'data-write-key': 'lump_test',
      'data-project': 'my-landing',
      'data-ingest-url': 'https://lumen-api.example',
      'data-consent': 'granted',
      'data-capture-errors': 'true',
    })
    const api = await boot()
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }))
    await api.client!.flush()
    const events = fetchMock.mock.calls.flatMap(
      ([, init]) => (JSON.parse(String(init?.body)) as { events: PulseEvent[] }).events,
    )
    expect(events.map((e) => [e.event_name, e.properties.message])).toEqual([['$exception', 'boom']])
  })

  it('records a masked session replay with data-replay="true"', async () => {
    addScript({
      'data-write-key': 'lump_test',
      'data-project': 'my-landing',
      'data-ingest-url': 'https://lumen-api.example',
      'data-consent': 'granted',
      'data-replay': 'true',
      'data-replay-sample-rate': '1',
    })
    const api = await boot()
    await vi.waitFor(() => expect(rr.options).toHaveLength(1))
    expect(rr.options[0]!.maskTextSelector).toBe('*')
    expect(rr.options[0]!.checkoutEveryNms).toBeUndefined() // sampled: streaming
    rr.options[0]!.emit({ type: 3, timestamp: Date.now(), data: {} })
    await api.client!.flush()
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('https://lumen-api.example/api/product/replay/chunk')
  })

  it('does not load rrweb without data-replay', async () => {
    addScript({
      'data-write-key': 'lump_test',
      'data-project': 'my-landing',
      'data-ingest-url': 'https://lumen-api.example',
      'data-consent': 'granted',
    })
    await boot()
    await new Promise((r) => setTimeout(r, 0))
    expect(rr.options).toHaveLength(0)
  })
})
