import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLumenPulse } from '../src/index.js'
import { normalizeError, topFrame } from '../src/errors.js'
import { memoryStorage } from '../src/storage.js'
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
    captureErrors: true,
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides,
  })
  clients.push(pulse)
  return { pulse, fetchMock }
}

function sent(fetchMock: ReturnType<typeof okFetch>): PulseEvent[] {
  return fetchMock.mock.calls.flatMap(
    ([, init]) => (JSON.parse(String(init?.body)) as { events: PulseEvent[] }).events,
  )
}

function exceptions(fetchMock: ReturnType<typeof okFetch>): PulseEvent[] {
  return sent(fetchMock).filter((e) => e.event_name === '$exception')
}

function errorWithStack(message: string, frame = 'at boom (https://app.test/assets/index-abc.js:10:5)') {
  const err = new TypeError(message)
  err.stack = `TypeError: ${message}\n    ${frame}\n    at main (https://app.test/assets/index-abc.js:1:1)`
  return err
}

function fireError(init: ErrorEventInit) {
  window.dispatchEvent(new ErrorEvent('error', init))
}

function fireRejection(reason: unknown) {
  const event = new Event('unhandledrejection') as Event & { reason: unknown }
  Object.defineProperty(event, 'reason', { value: reason })
  window.dispatchEvent(event)
}

beforeEach(() => {
  window.history.replaceState(null, '', '/checkout?token=secret')
})

afterEach(async () => {
  while (clients.length) await clients.pop()!.shutdown()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('captureErrors listeners', () => {
  it('installs error and unhandledrejection listeners and removes them on shutdown', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { pulse, fetchMock } = make()
    expect(add).toHaveBeenCalledWith('error', expect.any(Function))
    expect(add).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))
    await pulse.shutdown()
    expect(remove).toHaveBeenCalledWith('error', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))
    // a host listener of our own, so the test runner does not report the event as uncaught
    const host = (e: Event) => e.preventDefault()
    window.addEventListener('error', host)
    fireError({ message: 'after', error: new Error('after') })
    window.removeEventListener('error', host)
    await pulse.flush()
    expect(exceptions(fetchMock)).toHaveLength(0)
  })

  it('installs nothing when captureErrors is off', () => {
    const add = vi.spyOn(window, 'addEventListener')
    make({ captureErrors: false })
    const types = add.mock.calls.map(([type]) => type)
    expect(types).not.toContain('error')
    expect(types).not.toContain('unhandledrejection')
  })
})

describe('$exception payload', () => {
  it('sends an uncaught error with the contract shape', async () => {
    const { pulse, fetchMock } = make({
      appVersion: '1.2.3',
      captureErrors: { environment: 'production' },
    })
    const err = errorWithStack('x is undefined')
    fireError({ message: 'Uncaught TypeError: x is undefined', error: err, filename: 'https://app.test/a.js' })
    await pulse.flush()
    const [ev] = exceptions(fetchMock)
    expect(ev!.properties).toEqual({
      name: 'TypeError',
      message: 'x is undefined',
      stack: err.stack,
      handled: false,
      mechanism: 'onerror',
      release: '1.2.3',
      environment: 'production',
      count: 1,
    })
    expect(ev!.context.path).toBe('/checkout')
    expect(ev!.context.app_version).toBe('1.2.3')
  })

  it('uses captureErrors.release for properties and context.app_version', async () => {
    const { pulse, fetchMock } = make({ appVersion: '1.2.3', captureErrors: { release: 'abc123' } })
    pulse.captureException(new Error('x'))
    await pulse.flush()
    const [ev] = exceptions(fetchMock)
    expect(ev!.properties.release).toBe('abc123')
    expect(ev!.context.app_version).toBe('abc123')
  })

  it('sends unhandled rejections', async () => {
    const { pulse, fetchMock } = make()
    fireRejection(errorWithStack('fetch failed'))
    await pulse.flush()
    const [ev] = exceptions(fetchMock)
    expect(ev!.properties).toMatchObject({
      name: 'TypeError',
      message: 'fetch failed',
      handled: false,
      mechanism: 'unhandledrejection',
    })
    expect(String(ev!.properties.stack)).toContain('index-abc.js:10:5')
  })

  it('truncates message to 1000 and stack to 10000 chars', async () => {
    const { pulse, fetchMock } = make()
    const err = new Error('m'.repeat(5000))
    err.stack = 's'.repeat(50_000)
    pulse.captureException(err)
    await pulse.flush()
    const [ev] = exceptions(fetchMock)
    expect(String(ev!.properties.message)).toHaveLength(1000)
    expect(String(ev!.properties.stack)).toHaveLength(10_000)
  })
})

describe('non-Error values', () => {
  it('normalizes thrown strings, objects and primitives', () => {
    expect(normalizeError('boom')).toEqual({ name: 'Error', message: 'boom' })
    expect(normalizeError({ code: 42 })).toEqual({ name: 'Error', message: '{"code":42}' })
    expect(normalizeError({ name: 'ApiError', message: 'nope' })).toEqual({
      name: 'ApiError',
      message: 'nope',
    })
    expect(normalizeError(undefined)).toEqual({ name: 'Error', message: 'undefined' })
    expect(normalizeError(null)).toEqual({ name: 'Error', message: 'null' })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(normalizeError(circular).message).toBe('[object Object]')
  })

  it('names non-Error rejections UnhandledRejection', async () => {
    const { pulse, fetchMock } = make()
    fireRejection('plain string')
    fireRejection({ status: 500 })
    await pulse.flush()
    expect(exceptions(fetchMock).map((e) => [e.properties.name, e.properties.message])).toEqual([
      ['UnhandledRejection', 'plain string'],
      ['UnhandledRejection', '{"status":500}'],
    ])
  })

  it('builds a frame from the event location when no Error object exists', async () => {
    const { pulse, fetchMock } = make()
    fireError({ message: 'Uncaught boom', filename: 'https://app.test/a.js', lineno: 3, colno: 7 })
    await pulse.flush()
    const [ev] = exceptions(fetchMock)
    expect(ev!.properties.name).toBe('Error')
    expect(ev!.properties.message).toBe('boom')
    expect(ev!.properties.stack).toBe('Error: boom\n    at https://app.test/a.js:3:7')
  })
})

describe('filtering', () => {
  it('ignores cross-origin "Script error."', async () => {
    const { pulse, fetchMock } = make()
    fireError({ message: 'Script error.' })
    await pulse.flush()
    expect(exceptions(fetchMock)).toHaveLength(0)
  })

  it('drops errors matching the ignore list (string and RegExp)', async () => {
    const { pulse, fetchMock } = make({
      captureErrors: { ignore: ['ResizeObserver loop', /^chrome-extension/] },
    })
    pulse.captureException(new Error('ResizeObserver loop limit exceeded'))
    pulse.captureException(new Error('chrome-extension://abc failed'))
    pulse.captureException(new Error('kept'))
    await pulse.flush()
    expect(exceptions(fetchMock).map((e) => e.properties.message)).toEqual(['kept'])
  })

  it('sends nothing with sampleRate 0', async () => {
    const { pulse, fetchMock } = make({ captureErrors: { sampleRate: 0 } })
    pulse.captureException(new Error('a'))
    fireError({ message: 'b', error: new Error('b') })
    await pulse.flush()
    expect(exceptions(fetchMock)).toHaveLength(0)
  })
})

describe('dedup and cap', () => {
  it('sends the first occurrence and one count summary for repeats', async () => {
    const { pulse, fetchMock } = make()
    for (let i = 0; i < 5; i++) fireError({ message: 'x', error: errorWithStack('same') })
    await pulse.flush()
    const evs = exceptions(fetchMock)
    expect(evs.map((e) => e.properties.count)).toEqual([1, 4])
    expect(evs.every((e) => e.properties.message === 'same')).toBe(true)
  })

  it('treats a different top frame as a different error', async () => {
    const { pulse, fetchMock } = make()
    pulse.captureException(errorWithStack('same', 'at a (https://app.test/x.js:1:1)'))
    pulse.captureException(errorWithStack('same', 'at b (https://app.test/x.js:2:2)'))
    await pulse.flush()
    expect(exceptions(fetchMock).map((e) => e.properties.count)).toEqual([1, 1])
  })

  it('sends a repeat summary on the interval only after the repeat window', async () => {
    vi.useFakeTimers()
    const { pulse, fetchMock } = make({ flushIntervalMs: 2000 })
    pulse.captureException(errorWithStack('loop'))
    await vi.advanceTimersByTimeAsync(300) // prompt error flush
    expect(exceptions(fetchMock).map((e) => e.properties.count)).toEqual([1])
    for (let i = 0; i < 20; i++) pulse.captureException(errorWithStack('loop'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(exceptions(fetchMock)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(exceptions(fetchMock).map((e) => e.properties.count)).toEqual([1, 20])
    await pulse.shutdown()
  })

  it('caps distinct errors at maxPerMinute (default 10)', async () => {
    vi.useFakeTimers()
    const { pulse, fetchMock } = make()
    for (let i = 0; i < 15; i++) pulse.captureException(new Error(`distinct ${i}`))
    await pulse.flush()
    expect(exceptions(fetchMock)).toHaveLength(10)
    await vi.advanceTimersByTimeAsync(61_000)
    pulse.captureException(new Error('later'))
    await pulse.flush()
    expect(exceptions(fetchMock)).toHaveLength(11)
    await pulse.shutdown()
  })

  it('honours a custom maxPerMinute', async () => {
    const { pulse, fetchMock } = make({ captureErrors: { maxPerMinute: 2 } })
    for (let i = 0; i < 5; i++) pulse.captureException(new Error(`e${i}`))
    await pulse.flush()
    expect(exceptions(fetchMock)).toHaveLength(2)
  })

  it('starts dedup over after reset() (new session)', async () => {
    const { pulse, fetchMock } = make()
    pulse.captureException(new Error('same'))
    pulse.reset()
    pulse.captureException(new Error('same'))
    await pulse.flush()
    expect(exceptions(fetchMock).map((e) => e.properties.count)).toEqual([1, 1])
  })
})

describe('consent and delivery', () => {
  it('sends nothing before consent is granted, including later summaries', async () => {
    const { pulse, fetchMock } = make({ consent: 'unknown' })
    fireError({ message: 'x', error: new Error('early') })
    pulse.captureException(new Error('early'))
    await pulse.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    pulse.setConsent('granted')
    await pulse.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    pulse.captureException(new Error('after grant'))
    await pulse.flush()
    expect(exceptions(fetchMock).map((e) => e.properties.message)).toEqual(['after grant'])
  })

  it('drops pending repeat counts when consent is denied', async () => {
    const { pulse, fetchMock } = make()
    pulse.captureException(new Error('x'))
    pulse.captureException(new Error('x'))
    pulse.setConsent('denied')
    await pulse.flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('flushes errors promptly instead of waiting for the interval', async () => {
    vi.useFakeTimers()
    const { pulse, fetchMock } = make({ flushIntervalMs: 2000 })
    pulse.captureException(new Error('a'))
    pulse.captureException(new Error('b'))
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    // one request carrying both: bursts still batch
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(exceptions(fetchMock)).toHaveLength(2)
    await pulse.shutdown()
  })
})

describe('captureException', () => {
  it('marks handled errors as manual and merges extra without overriding core fields', async () => {
    const { pulse, fetchMock } = make({ captureErrors: false })
    pulse.captureException(errorWithStack('render failed'), {
      component: 'Cart',
      name: 'Spoofed',
      message: 'spoofed',
      stack: 'spoofed',
      handled: false,
      count: 99,
    })
    await pulse.flush()
    const [ev] = exceptions(fetchMock)
    expect(ev!.properties).toMatchObject({
      component: 'Cart',
      name: 'TypeError',
      message: 'render failed',
      handled: true,
      mechanism: 'manual',
      count: 1,
    })
    expect(ev!.properties.stack).not.toBe('spoofed')
  })

  it('never throws into the host app', () => {
    const { pulse } = make()
    const hostile = {
      get message(): string {
        throw new Error('getter')
      },
    }
    expect(() => pulse.captureException(hostile)).not.toThrow()
  })
})

describe('topFrame', () => {
  it('finds V8 and Firefox/Safari frames', () => {
    expect(topFrame('TypeError: x\n    at f (https://a/b.js:1:2)')).toBe('at f (https://a/b.js:1:2)')
    expect(topFrame('f@https://a/b.js:1:2\ng@https://a/b.js:3:4')).toBe('f@https://a/b.js:1:2')
    expect(topFrame(undefined)).toBe('')
  })
})
