/** Consent state for analytics cookies / storage. */
export type ConsentStatus = 'granted' | 'denied' | 'unknown'

/** Wire discriminator — Lumen-compatible signal family. */
export type SignalKind = 'product'

export interface PulseContext {
  path?: string
  referrer?: string
  utm?: Record<string, string>
  locale?: string
  app_version?: string
  user_agent_class?: 'mobile' | 'desktop' | 'bot' | 'unknown'
  consent?: ConsentStatus
  [key: string]: unknown
}

export interface PulseEvent {
  signal_kind: SignalKind
  event_id: string
  event_name: string
  occurred_at: string
  project: string
  organization_uuid?: string
  anonymous_id: string | null
  user_id: string | null
  org_id?: string | null
  session_id: string
  properties: Record<string, unknown>
  context: PulseContext
}

export interface LumenPulseConfig {
  /** Pulse product write-key (`lump_…`). Never use collector `lumk_` keys. */
  writeKey: string
  /** Product / project slug the key is bound to, e.g. `my-landing`. */
  project: string
  /** Ingest base URL, e.g. `https://lumen-api.orkestia.dev` or a same-origin proxy. */
  ingestUrl: string
  /** Optional org UUID when known at init. */
  organizationUuid?: string
  /** Batch flush interval in ms. Default 2000. */
  flushIntervalMs?: number
  /** Max events per batch. Default 20, capped at 50 (browser key limit). */
  maxBatchSize?: number
  /**
   * Where anonymous_id / session_id are persisted once consent is granted.
   * Default: localStorage when available. `null` keeps everything in memory.
   */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** Override fetch (tests / non-browser). Default: global fetch. */
  fetch?: typeof fetch
  /**
   * Send one `page_view` at boot. Same as `autocapture: { pageViews: true }`.
   * Default false.
   */
  autocapturePageViews?: boolean
  /** Automatic event capture. */
  autocapture?: AutocaptureConfig
  /**
   * Send uncaught errors and unhandled promise rejections as `$exception`
   * events, which Lumen groups as errors. Default false. `captureException()`
   * works either way.
   */
  captureErrors?: boolean | CaptureErrorsConfig
  /**
   * Masked session replay (rrweb), loaded on demand once consent is
   * `granted`. `true` uses the defaults. Default off.
   */
  replay?: boolean | ReplayConfig
  /**
   * Query params allowed into `context.path`. By default the path is
   * `location.pathname` only (no query string). Entries are exact names or a
   * prefix glob ending in `*`, e.g. `['utm_*', 'ref']`.
   */
  includeQueryParams?: string[]
  /** App version stamped into context. */
  appVersion?: string
  /**
   * Minutes without activity (tracked events, errors, user input seen by
   * replay, the tab becoming visible) after which a new session_id starts.
   * Default 30.
   */
  sessionTimeoutMinutes?: number
  /** Hours after which a session is rotated even while active. Default 24. */
  sessionMaxHours?: number
  /** Initial consent. Default `unknown` (no cookie until granted). */
  consent?: ConsentStatus
  /**
   * Called when a batch is dropped (never throws to the host app). Ingest
   * rejections arrive as `LumenPulseError` with `status` and `code`.
   */
  onError?: (error: unknown) => void
}

export interface AutocaptureConfig {
  /**
   * `true` sends one `page_view` at boot. `'history'` also sends one on every
   * `pushState` / `replaceState` / `popstate` that changes the path (SPA
   * routing), deduplicated by path. Default false.
   */
  pageViews?: boolean | 'history'
}

export interface CaptureErrorsConfig {
  /**
   * Drop errors whose message (or `Name: message`) contains a string or
   * matches a RegExp. Cross-origin `Script error.` is always dropped.
   */
  ignore?: (string | RegExp)[]
  /** Fraction of errors kept, 0 to 1. Default 1. */
  sampleRate?: number
  /** Most `$exception` events sent per minute (first sends + repeat summaries). Default 10. */
  maxPerMinute?: number
  /** Build / release id. Default `appVersion`. */
  release?: string
  /** e.g. `production`, `staging`. */
  environment?: string
}

export interface ReplayConfig {
  /** Fraction of sessions recorded from the start, 0 to 1. Default 0.1. */
  sampleRate?: number
  /**
   * Fraction of unsampled sessions whose last `bufferSeconds` are uploaded
   * when an error is captured (they then keep recording). Default 1.
   */
  onErrorSampleRate?: number
  /** Seconds kept in memory for unsampled sessions. Default 60. */
  bufferSeconds?: number
  /** Replace all page text with `*`. Also masks inputs. Default true. */
  maskAllText?: boolean
  /** Replace all input values with `*`. Default true. */
  maskAllInputs?: boolean
  /** Elements matching this selector (and their children) are not recorded. Default `[data-private]`. */
  blockSelector?: string
  /**
   * Most gzip bytes per uploaded chunk. Default 45000, which keeps the
   * base64 request body near 60 KB, inside the browser's keepalive budget.
   */
  maxChunkBytes?: number
}

/** What each replay chunk declares about masking. */
export type ReplayMaskLevel = 'all' | 'inputs' | 'none'

/** Why a replay chunk was uploaded. */
export type ReplayTrigger = 'sampled' | 'error'

/** Body of `POST /api/product/replay/chunk`. */
export interface ReplayChunk {
  project: string
  session_id: string
  seq: number
  started_at: string
  ended_at: string
  mask_level: ReplayMaskLevel
  trigger: ReplayTrigger
  has_error: boolean
  user_id: string
  anonymous_id: string
  /** base64 of gzip(JSON array of rrweb events). */
  data: string
}

/** How an error reached the SDK. */
export type ErrorMechanism = 'onerror' | 'unhandledrejection' | 'manual'

export type TrackProperties = Record<string, unknown>

export interface LumenPulseClient {
  track(eventName: string, properties?: TrackProperties, context?: Partial<PulseContext>): void
  identify(userId: string, traits?: TrackProperties): void
  /**
   * Report a handled error (error boundary, fetch wrapper) as `$exception`
   * with `handled: true`. `extra` is merged into properties but cannot
   * override `name`, `message`, `stack`, `handled`, `mechanism` or `count`.
   */
  captureException(error: unknown, extra?: TrackProperties): void
  reset(): void
  setConsent(status: ConsentStatus): void
  getAnonymousId(): string | null
  getSessionId(): string
  flush(): Promise<void>
  /** Flush, stop the timer and replay recording, and remove page listeners / history hooks. */
  shutdown(): Promise<void>
}
