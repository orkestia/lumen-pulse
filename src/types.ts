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
  /** Product / project slug, e.g. `posto-regulado`, `faladelivery`. */
  project: string
  /** Ingest base URL, e.g. `https://api-lumen.example` or same-origin proxy. */
  ingestUrl: string
  /** Optional org UUID when known at init. */
  organizationUuid?: string
  /** Batch flush interval in ms. Default 2000. */
  flushIntervalMs?: number
  /** Max events per batch. Default 20. */
  maxBatchSize?: number
  /** Persist anonymous_id. Default: localStorage when available. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** Override fetch (tests / non-browser). Default: global fetch. */
  fetch?: typeof fetch
  /** Autocapture page views when path changes. Default false. */
  autocapturePageViews?: boolean
  /** App version stamped into context. */
  appVersion?: string
  /** Initial consent. Default `unknown` (no cookie until granted). */
  consent?: ConsentStatus
  /** Called on transport failures (never throws to the host app). */
  onError?: (error: unknown) => void
}

export type TrackProperties = Record<string, unknown>

export interface LumenPulseClient {
  track(eventName: string, properties?: TrackProperties, context?: Partial<PulseContext>): void
  identify(userId: string, traits?: TrackProperties): void
  reset(): void
  setConsent(status: ConsentStatus): void
  getAnonymousId(): string | null
  getSessionId(): string
  flush(): Promise<void>
  shutdown(): Promise<void>
}
