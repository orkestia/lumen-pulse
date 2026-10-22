import { currentPath, defaultContext } from './context.js'
import {
  EXCEPTION_EVENT,
  ErrorDeduper,
  exceptionProperties,
  fingerprintOf,
  fromErrorEvent,
  fromRejection,
  isIgnored,
  isOpaqueScriptError,
  normalizeError,
  resolveErrorOptions,
  type EmitRequest,
  type NormalizedError,
} from './errors.js'
import {
  ANON_KEY,
  CONSENT_KEY,
  SESSION_KEY,
  resolveStorage,
  uuid,
  type StorageLike,
} from './storage.js'
import { chunkEvents, sendBatch } from './transport.js'
import type {
  ConsentStatus,
  ErrorMechanism,
  LumenPulseClient,
  LumenPulseConfig,
  PulseContext,
  PulseEvent,
  TrackProperties,
} from './types.js'

const DEFAULT_FLUSH_MS = 2000
const DEFAULT_BATCH = 20
/** Errors flush after this short delay instead of the full interval (bursts still batch). */
const ERROR_FLUSH_DELAY_MS = 250

export function createLumenPulse(config: LumenPulseConfig): LumenPulseClient {
  if (!config.writeKey) throw new Error('lumen-pulse: writeKey is required')
  if (!config.project) throw new Error('lumen-pulse: project is required')
  if (!config.ingestUrl) throw new Error('lumen-pulse: ingestUrl is required')
  if (!config.writeKey.startsWith('lump_')) {
    // Soft warning only — do not throw (tests / staging may use mocks).
    console.warn(
      'lumen-pulse: writeKey should start with lump_ (Pulse product key). Do not use lumk_ collector keys.',
    )
  }

  const storage = resolveStorage(config.storage)
  const fetchImpl = config.fetch ?? fetch.bind(globalThis)
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_MS
  const maxBatchSize = Math.min(config.maxBatchSize ?? DEFAULT_BATCH, 50)

  let consent: ConsentStatus = loadConsent(storage, config.consent)
  let anonymousId: string | null = consent === 'granted' ? loadOrCreate(storage, ANON_KEY) : null
  // session_id only touches storage once consent is granted; until then it
  // lives in memory and is persisted on grant (cleared on deny).
  let sessionId = consent === 'granted' ? loadOrCreate(storage, SESSION_KEY) : uuid()
  let userId: string | null = null
  let orgId: string | null = null
  let queue: PulseEvent[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let errorTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  const cleanups: Array<() => void> = []
  const errorOptions = resolveErrorOptions(config.captureErrors, config.appVersion)
  const deduper = new ErrorDeduper(errorOptions.maxPerMinute)

  const schedule = () => {
    if (timer || closed) return
    timer = setInterval(() => {
      void flushQueue(false)
    }, flushIntervalMs)
    // Node timers support unref; browsers do not
    const t = timer as unknown as { unref?: () => void }
    t.unref?.()
  }

  const scheduleErrorFlush = () => {
    if (errorTimer || closed) return
    errorTimer = setTimeout(() => {
      errorTimer = null
      void flushQueue(false)
    }, Math.min(ERROR_FLUSH_DELAY_MS, flushIntervalMs))
    const t = errorTimer as unknown as { unref?: () => void }
    t.unref?.()
  }

  const enqueue = (event: PulseEvent) => {
    if (closed) return
    // LGPD: no product analytics until consent is explicitly granted
    if (consent !== 'granted') return
    queue.push(event)
    if (queue.length >= maxBatchSize) {
      void flushQueue(false)
    } else {
      schedule()
    }
  }

  const buildEvent = (
    eventName: string,
    properties: TrackProperties = {},
    contextPatch: Partial<PulseContext> = {},
  ): PulseEvent => {
    const base = defaultContext({
      appVersion: config.appVersion,
      includeQueryParams: config.includeQueryParams,
    }) as PulseContext
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

  const exceptionEvent = (emit: EmitRequest): PulseEvent => {
    const patch: Partial<PulseContext> = {}
    if (emit.path !== undefined) patch.path = emit.path
    // The ingest bridge reads the error's release from context.app_version.
    if (errorOptions.release) patch.app_version = errorOptions.release
    return buildEvent(EXCEPTION_EVENT, emit.properties, patch)
  }

  const captureError = (
    error: NormalizedError,
    handled: boolean,
    mechanism: ErrorMechanism,
    extra?: TrackProperties,
  ) => {
    if (closed || consent !== 'granted') return
    if (isIgnored(error, errorOptions.ignore)) return
    if (errorOptions.sampleRate < 1 && Math.random() >= errorOptions.sampleRate) return
    const properties = exceptionProperties(error, handled, mechanism, errorOptions, extra)
    const path = typeof location !== 'undefined' ? currentPath(config.includeQueryParams) : undefined
    const emit = deduper.record(fingerprintOf(error), properties, path)
    if (emit) {
      enqueue(exceptionEvent(emit))
      scheduleErrorFlush()
    } else if (deduper.hasPending()) {
      // The interval tick sends the repeat summary once its window is due.
      schedule()
    }
  }

  /**
   * Send the queue. `force` also sends repeat summaries that are not due yet
   * (explicit flush, unload, shutdown).
   */
  const flushQueue = async (force: boolean): Promise<void> => {
    if (consent === 'granted') {
      for (const emit of deduper.drain(force)) queue.push(exceptionEvent(emit))
    }
    if (queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    const transport = {
      ingestUrl: config.ingestUrl,
      writeKey: config.writeKey,
      fetchImpl,
      ...(config.onError ? { onError: config.onError } : {}),
    }
    // All chunks start synchronously so an unload flush gets every request
    // out before the page is torn down.
    await Promise.all(chunkEvents(batch, maxBatchSize).map((chunk) => sendBatch(chunk, transport)))
  }

  const flush = (): Promise<void> => flushQueue(true)

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

    captureException(error, extra) {
      try {
        captureError(normalizeError(error), true, 'manual', extra)
      } catch {
        // never throw into the host app
      }
    },

    reset() {
      userId = null
      orgId = null
      sessionId = uuid()
      deduper.clear() // dedup is per session
      if (consent === 'granted') {
        storage.setItem(SESSION_KEY, sessionId)
        anonymousId = uuid()
        storage.setItem(ANON_KEY, anonymousId)
      } else {
        anonymousId = null
        storage.removeItem(SESSION_KEY)
        storage.removeItem(ANON_KEY)
      }
    },

    setConsent(status) {
      consent = status
      storage.setItem(CONSENT_KEY, status)
      if (status === 'granted') {
        anonymousId = loadOrCreate(storage, ANON_KEY)
        storage.setItem(SESSION_KEY, sessionId)
      } else if (status === 'denied') {
        anonymousId = null
        storage.removeItem(ANON_KEY)
        storage.removeItem(SESSION_KEY)
        queue = []
        deduper.clear()
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
      if (errorTimer) {
        clearTimeout(errorTimer)
        errorTimer = null
      }
      while (cleanups.length) cleanups.pop()?.()
      await flush()
    },
  }

  if (typeof window !== 'undefined') {
    cleanups.push(listenForUnload(() => void flush()))

    if (config.captureErrors) {
      cleanups.push(
        listenForErrors(
          (event) => {
            if (isOpaqueScriptError(event)) return
            captureError(fromErrorEvent(event), false, 'onerror')
          },
          (reason) => captureError(fromRejection(reason), false, 'unhandledrejection'),
        ),
      )
    }

    const pageViews = config.autocapture?.pageViews ?? (config.autocapturePageViews === true)
    if (pageViews === 'history') {
      let lastPath = currentPath(config.includeQueryParams)
      client.track('page_view')
      cleanups.push(
        watchHistory(() => {
          if (closed) return
          const path = currentPath(config.includeQueryParams)
          if (path === lastPath) return
          lastPath = path
          client.track('page_view')
        }),
      )
    } else if (pageViews) {
      client.track('page_view')
    }
  }

  return client
}

/**
 * Flush when the page is hidden or unloaded. `fetch(keepalive)` lets the
 * request outlive the page; `sendBeacon` cannot carry the X-Api-Key header.
 */
function listenForUnload(onHide: () => void): () => void {
  const onPageHide = () => onHide()
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') onHide()
  }
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

/**
 * Uncaught errors and unhandled rejections. Only `ErrorEvent`s are handled:
 * resource load failures (img, script) do not bubble to window and carry no
 * message. Handlers never throw.
 */
function listenForErrors(
  onError: (event: ErrorEvent) => void,
  onRejection: (reason: unknown) => void,
): () => void {
  const handleError = (event: Event) => {
    try {
      const e = event as ErrorEvent
      if (typeof e.message !== 'string' && e.error === undefined) return
      onError(e)
    } catch {
      // never throw from a global error handler
    }
  }
  const handleRejection = (event: Event) => {
    try {
      onRejection((event as PromiseRejectionEvent).reason)
    } catch {
      // never throw from a global error handler
    }
  }
  window.addEventListener('error', handleError)
  window.addEventListener('unhandledrejection', handleRejection)
  return () => {
    window.removeEventListener('error', handleError)
    window.removeEventListener('unhandledrejection', handleRejection)
  }
}

/** Call `onChange` after pushState / replaceState / popstate. */
function watchHistory(onChange: () => void): () => void {
  const history = window.history
  const originalPush = history.pushState
  const originalReplace = history.replaceState
  let active = true
  const wrap = (original: History['pushState']): History['pushState'] =>
    function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args)
      if (active) onChange()
      return result
    }
  const wrappedPush = wrap(originalPush)
  const wrappedReplace = wrap(originalReplace)
  history.pushState = wrappedPush
  history.replaceState = wrappedReplace
  const onPopState = () => onChange()
  window.addEventListener('popstate', onPopState)
  return () => {
    active = false
    window.removeEventListener('popstate', onPopState)
    // Only unpatch if nobody wrapped on top of us; otherwise stay as a no-op.
    if (history.pushState === wrappedPush) history.pushState = originalPush
    if (history.replaceState === wrappedReplace) history.replaceState = originalReplace
  }
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
