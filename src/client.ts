import { defaultContext } from './context.js'
import {
  ANON_KEY,
  CONSENT_KEY,
  SESSION_KEY,
  resolveStorage,
  uuid,
  type StorageLike,
} from './storage.js'
import { sendBatch } from './transport.js'
import type {
  ConsentStatus,
  LumenPulseClient,
  LumenPulseConfig,
  PulseContext,
  PulseEvent,
  TrackProperties,
} from './types.js'

const DEFAULT_FLUSH_MS = 2000
const DEFAULT_BATCH = 20

export function createLumenPulse(config: LumenPulseConfig): LumenPulseClient {
  if (!config.writeKey) throw new Error('lumen-pulse: writeKey is required')
  if (!config.project) throw new Error('lumen-pulse: project is required')
  if (!config.ingestUrl) throw new Error('lumen-pulse: ingestUrl is required')

  const storage = resolveStorage(config.storage)
  const fetchImpl = config.fetch ?? fetch.bind(globalThis)
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_MS
  const maxBatchSize = config.maxBatchSize ?? DEFAULT_BATCH

  let consent: ConsentStatus = loadConsent(storage, config.consent)
  let anonymousId: string | null = consent === 'granted' ? loadOrCreate(storage, ANON_KEY) : null
  let sessionId = loadOrCreate(storage, SESSION_KEY)
  let userId: string | null = null
  let orgId: string | null = null
  let queue: PulseEvent[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let closed = false

  const schedule = () => {
    if (timer || closed) return
    timer = setInterval(() => {
      void flush()
    }, flushIntervalMs)
    // Node timers support unref; browsers do not
    const t = timer as unknown as { unref?: () => void }
    t.unref?.()
  }

  const enqueue = (event: PulseEvent) => {
    if (closed) return
    // LGPD: no product analytics until consent is explicitly granted
    if (consent !== 'granted') return
    queue.push(event)
    if (queue.length >= maxBatchSize) {
      void flush()
    } else {
      schedule()
    }
  }

  const buildEvent = (
    eventName: string,
    properties: TrackProperties = {},
    contextPatch: Partial<PulseContext> = {},
  ): PulseEvent => {
    const base = defaultContext(config.appVersion) as PulseContext
    const context: PulseContext = {
      ...base,
      ...contextPatch,
      consent,
    }
    const event: PulseEvent = {
      signal_kind: 'product',
      event_id: uuid(),
      event_name: eventName,
      occurred_at: new Date().toISOString(),
      project: config.project,
      anonymous_id: anonymousId,
      user_id: userId,
      session_id: sessionId,
      properties: { ...properties },
      context,
    }
    if (config.organizationUuid) event.organization_uuid = config.organizationUuid
    if (orgId) event.org_id = orgId
    return event
  }

  const flush = async (): Promise<void> => {
    if (queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    await sendBatch(batch, {
      ingestUrl: config.ingestUrl,
      writeKey: config.writeKey,
      fetchImpl,
      ...(config.onError ? { onError: config.onError } : {}),
    })
  }

  const client: LumenPulseClient = {
    track(eventName, properties = {}, context) {
      enqueue(buildEvent(eventName, properties, context ?? {}))
    },

    identify(nextUserId, traits = {}) {
      if (!nextUserId) return
      const previousAnon = anonymousId
      userId = nextUserId
      if (typeof traits.org_id === 'string') orgId = traits.org_id
      if (typeof traits.organization_uuid === 'string' && !config.organizationUuid) {
        // stamped only on this alias event via properties/context; org stays on config
      }
      enqueue(
        buildEvent('identity.alias', {
          ...traits,
          aliased_anonymous_id: previousAnon,
        }),
      )
    },

    reset() {
      userId = null
      orgId = null
      sessionId = uuid()
      storage.setItem(SESSION_KEY, sessionId)
      if (consent === 'granted') {
        anonymousId = uuid()
        storage.setItem(ANON_KEY, anonymousId)
      } else {
        anonymousId = null
        storage.removeItem(ANON_KEY)
      }
    },

    setConsent(status) {
      consent = status
      storage.setItem(CONSENT_KEY, status)
      if (status === 'granted') {
        anonymousId = loadOrCreate(storage, ANON_KEY)
      } else if (status === 'denied') {
        anonymousId = null
        storage.removeItem(ANON_KEY)
        queue = []
      }
    },

    getAnonymousId() {
      return anonymousId
    },

    getSessionId() {
      return sessionId
    },

    flush,

    async shutdown() {
      closed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      await flush()
    },
  }

  if (config.autocapturePageViews && typeof window !== 'undefined') {
    client.track('page_view')
  }

  return client
}

function loadConsent(storage: StorageLike, initial?: ConsentStatus): ConsentStatus {
  const stored = storage.getItem(CONSENT_KEY)
  if (stored === 'granted' || stored === 'denied' || stored === 'unknown') return stored
  return initial ?? 'unknown'
}

function loadOrCreate(storage: StorageLike, key: string): string {
  const existing = storage.getItem(key)
  if (existing) return existing
  const id = uuid()
  storage.setItem(key, id)
  return id
}
