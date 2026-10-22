import type { CaptureErrorsConfig, ErrorMechanism, TrackProperties } from './types.js'

/** Reserved event name the ingest API turns into a Lumen error group. */
export const EXCEPTION_EVENT = '$exception'

export const MAX_MESSAGE_CHARS = 1000
export const MAX_STACK_CHARS = 10_000
export const DEFAULT_MAX_PER_MINUTE = 10
/** Repeats of one error are summarised at most once per this window. */
export const REPEAT_WINDOW_MS = 60_000

const MINUTE_MS = 60_000

/** Properties the SDK owns on `$exception`; `extra` can never override them. */
const RESERVED_KEYS = ['name', 'message', 'stack', 'handled', 'mechanism', 'count'] as const

export interface NormalizedError {
  name: string
  message: string
  stack?: string
}

export interface ResolvedErrorOptions {
  ignore: readonly (string | RegExp)[]
  sampleRate: number
  maxPerMinute: number
  release?: string
  environment?: string
}

export function resolveErrorOptions(
  config: boolean | CaptureErrorsConfig | undefined,
  appVersion: string | undefined,
): ResolvedErrorOptions {
  const cfg = typeof config === 'object' && config !== null ? config : {}
  const rate = typeof cfg.sampleRate === 'number' && !Number.isNaN(cfg.sampleRate) ? cfg.sampleRate : 1
  const out: ResolvedErrorOptions = {
    ignore: cfg.ignore ?? [],
    sampleRate: Math.min(1, Math.max(0, rate)),
    maxPerMinute: Math.max(0, cfg.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE),
  }
  const release = cfg.release ?? appVersion
  if (release) out.release = release
  if (cfg.environment) out.environment = cfg.environment
  return out
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    if (typeof json === 'string' && json !== '{}') return json
  } catch {
    // circular or BigInt: fall through
  }
  try {
    return String(value)
  } catch {
    return '[unserializable]'
  }
}

/**
 * Turn anything that was thrown into `{ name, message, stack? }`.
 * Errors (also from other realms) keep their own fields; strings become the
 * message; plain objects use their `message` / `name` when present, else
 * their JSON.
 */
export function normalizeError(value: unknown, fallbackName = 'Error'): NormalizedError {
  let name = fallbackName
  let message: string
  let stack: string | undefined
  if (typeof value === 'string') {
    message = value
  } else if (value !== null && typeof value === 'object') {
    const obj = value as { name?: unknown; message?: unknown; stack?: unknown }
    const ctor = (value as { constructor?: { name?: unknown } }).constructor?.name
    if (typeof obj.name === 'string' && obj.name) name = obj.name
    else if (typeof ctor === 'string' && ctor && ctor !== 'Object') name = ctor
    message = typeof obj.message === 'string' ? obj.message : safeStringify(value)
    if (typeof obj.stack === 'string' && obj.stack) stack = obj.stack
  } else {
    message = safeStringify(value)
  }
  const out: NormalizedError = { name, message: truncate(message, MAX_MESSAGE_CHARS) }
  if (stack) out.stack = truncate(stack, MAX_STACK_CHARS)
  return out
}

/** First stack line that looks like a frame (V8 `at …`, or Firefox/Safari `fn@url:l:c`). */
export function topFrame(stack: string | undefined): string {
  if (!stack) return ''
  for (const raw of stack.split('\n')) {
    const line = raw.trim()
    if (/^at\s/.test(line) || /@.*:\d+(:\d+)?$/.test(line)) return line
  }
  return ''
}

export function fingerprintOf(error: NormalizedError): string {
  return `${error.name}\n${error.message}\n${topFrame(error.stack)}`
}

export function isIgnored(error: NormalizedError, ignore: readonly (string | RegExp)[]): boolean {
  const full = `${error.name}: ${error.message}`
  return ignore.some((pattern) =>
    typeof pattern === 'string'
      ? error.message.includes(pattern) || full.includes(pattern)
      : pattern.test(error.message) || pattern.test(full),
  )
}

/**
 * Cross-origin scripts without `crossorigin="anonymous"` report only
 * "Script error." with no stack or location. Nothing useful to group on.
 */
export function isOpaqueScriptError(event: ErrorEvent): boolean {
  return /^Script error\.?$/.test(event.message ?? '') && !event.error && !event.filename
}

/** Normalize a window `error` event, synthesising a frame from its location. */
export function fromErrorEvent(event: ErrorEvent): NormalizedError {
  if (event.error !== undefined && event.error !== null) {
    const normalized = normalizeError(event.error)
    if (normalized.stack || !event.filename) return normalized
    return { ...normalized, stack: syntheticStack(normalized, event) }
  }
  const message = (event.message ?? '').replace(/^Uncaught\s+/, '')
  const normalized: NormalizedError = { name: 'Error', message: truncate(message, MAX_MESSAGE_CHARS) }
  if (event.filename) normalized.stack = syntheticStack(normalized, event)
  return normalized
}

function syntheticStack(error: NormalizedError, event: ErrorEvent): string {
  const location = `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
  return truncate(`${error.name}: ${error.message}\n    at ${location}`, MAX_STACK_CHARS)
}

/** Normalize a promise rejection reason. Non-Error reasons are named `UnhandledRejection`. */
export function fromRejection(reason: unknown): NormalizedError {
  const isErrorLike =
    reason instanceof Error ||
    (reason !== null &&
      typeof reason === 'object' &&
      typeof (reason as { stack?: unknown }).stack === 'string')
  return normalizeError(reason, isErrorLike ? 'Error' : 'UnhandledRejection')
}

export function exceptionProperties(
  error: NormalizedError,
  handled: boolean,
  mechanism: ErrorMechanism,
  options: ResolvedErrorOptions,
  extra: TrackProperties = {},
): TrackProperties {
  const props: TrackProperties = { ...extra }
  for (const key of RESERVED_KEYS) delete props[key]
  props.name = error.name
  props.message = error.message
  if (error.stack) props.stack = error.stack
  props.handled = handled
  props.mechanism = mechanism
  if (options.release && props.release === undefined) props.release = options.release
  if (options.environment && props.environment === undefined) props.environment = options.environment
  props.count = 1
  return props
}

interface Seen {
  properties: TrackProperties
  path: string | undefined
  pending: number
  lastSentAt: number
}

export interface EmitRequest {
  properties: TrackProperties
  path?: string | undefined
}

/**
 * Session-scoped dedup and rate cap for `$exception`.
 *
 * - The first occurrence of an error (name + message + top frame) is emitted
 *   with `count: 1`.
 * - Repeats are counted, not sent. `drain()` emits one follow-up per error
 *   with `count: <repeats since the last report>`, at most once per
 *   `REPEAT_WINDOW_MS` (or right away when `force`, e.g. flush / unload).
 * - Every emitted event (first or follow-up) counts toward `maxPerMinute`.
 *   A new error over the cap is dropped; a follow-up over the cap waits.
 */
export class ErrorDeduper {
  private seen = new Map<string, Seen>()
  private sentAt: number[] = []

  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns what to emit now, or null when the error is a repeat or capped. */
  record(fingerprint: string, properties: TrackProperties, path: string | undefined): EmitRequest | null {
    const existing = this.seen.get(fingerprint)
    if (existing) {
      existing.pending++
      existing.properties = properties
      existing.path = path
      return null
    }
    if (!this.take()) return null
    this.seen.set(fingerprint, { properties, path, pending: 0, lastSentAt: this.now() })
    return { properties, path }
  }

  hasPending(): boolean {
    for (const s of this.seen.values()) if (s.pending > 0) return true
    return false
  }

  /** Follow-up events for repeats that are due (all of them when `force`). */
  drain(force: boolean): EmitRequest[] {
    const out: EmitRequest[] = []
    const now = this.now()
    for (const s of this.seen.values()) {
      if (s.pending === 0) continue
      if (!force && now - s.lastSentAt < REPEAT_WINDOW_MS) continue
      if (!this.take()) break
      out.push({ properties: { ...s.properties, count: s.pending }, path: s.path })
      s.pending = 0
      s.lastSentAt = now
    }
    return out
  }

  clear(): void {
    this.seen.clear()
    this.sentAt = []
  }

  private take(): boolean {
    const now = this.now()
    this.sentAt = this.sentAt.filter((t) => now - t < MINUTE_MS)
    if (this.sentAt.length >= this.maxPerMinute) return false
    this.sentAt.push(now)
    return true
  }
}
