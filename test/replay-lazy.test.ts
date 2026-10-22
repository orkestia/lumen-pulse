import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLumenPulse } from '../src/index.js'
import { memoryStorage } from '../src/storage.js'
import type { LumenPulseClient } from '../src/types.js'

// Counts how often rrweb is actually imported (the factory runs on first import).
const loads = vi.hoisted(() => ({ count: 0 }))

vi.mock('rrweb', () => {
  loads.count++
  return { record: vi.fn(() => () => {}) }
})

const clients: LumenPulseClient[] = []

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

afterEach(async () => {
  while (clients.length) await clients.pop()!.shutdown()
})

describe('rrweb lazy loading', () => {
  it('imports rrweb only once replay is on and consent is granted', async () => {
    const base = {
      writeKey: 'lump_test',
      project: 'p',
      ingestUrl: 'http://pulse.test',
      fetch: vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof fetch,
    }
    clients.push(createLumenPulse({ ...base, storage: memoryStorage(), consent: 'granted' }))
    await settle()
    expect(loads.count).toBe(0) // replay off

    const pulse = createLumenPulse({ ...base, storage: memoryStorage(), consent: 'unknown', replay: true })
    clients.push(pulse)
    await settle()
    expect(loads.count).toBe(0) // no consent yet

    pulse.setConsent('granted')
    await settle()
    expect(loads.count).toBe(1)
  })
})
