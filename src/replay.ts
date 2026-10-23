import { filterQuery } from './context.js'
import type { StorageLike } from './storage.js'
import { LumenPulseError, postWithRetry, type TransportConfig } from './transport.js'
import type { ReplayChunk, ReplayConfig, ReplayMaskLevel, ReplayTrigger } from './types.js'

export const REPLAY_PATH = '/api/product/replay/chunk'
export const REPLAY_KEY = 'lumen_pulse.replay'

export const DEFAULT_REPLAY_SAMPLE_RATE = 0.1
export const DEFAULT_ON_ERROR_SAMPLE_RATE = 1
export const DEFAULT_BUFFER_SECONDS = 60
export const DEFAULT_BLOCK_SELECTOR = '[data-private]'
/** gzip bytes; base64 (x4/3) plus the envelope stays under the 60 KB keepalive budget. */
export const DEFAULT_MAX_CHUNK_BYTES = 45_000
/** Server cap on one chunk's gzip bytes (`413 REPLAY_CHUNK_TOO_LARGE`). */
export const MAX_SERVER_CHUNK_BYTES = 512 * 1024
/** Streaming sessions upload at least this often. */
export const CHUNK_INTERVAL_MS = 10_000

/** First guess of JSON bytes per gzip byte; refined from each compressed chunk. */
const INITIAL_RATIO = 4

/** Codes after which replay stays off for the rest of the page's session. */
const STOP_CODES = new Set(['REPLAY_NOT_ENABLED', 'REPLAY_QUOTA_EXCEEDED', 'REPLAY_UNMASKED_FORBIDDEN'])

/** The part of an rrweb event the SDK reads. */
export interface RrwebEvent {
  type: number
  timestamp: number
  data?: unknown
}

/** The subset of rrweb `record()` options the SDK sets. */
export interface RecordOptions {
  emit: (event: RrwebEvent, isCheckout?: boolean) => void
  maskAllInputs: boolean
  maskTextSelector?: string
  blockSelector?: string
  checkoutEveryNms?: number
}

export type RecordFn = (options: RecordOptions) => (() => void) | undefined

/** rrweb `EventType.Meta`: carries the page URL. */
const META_EVENT = 4
/** rrweb `EventType.IncrementalSnapshot`. */
const INCREMENTAL_EVENT = 3
/**
 * Incremental sources that mean a person is there (mouse, scroll, input,
 * touch, media, drag, selection). DOM mutations alone do not keep a session alive.
 */
const USER_INPUT_SOURCES = new Set([1, 2, 3, 5, 6, 7, 12, 14])

export interface ResolvedReplayOptions {
  sampleRate: number
  onErrorSampleRate: number
  bufferMs: number
  maskAllText: boolean
  maskAllInputs: boolean
  blockSelector: string
  maxChunkBytes: number
  maskLevel: ReplayMaskLevel
}

function rate(value: number | undefined, fallback: number): number {
  const n = typeof value === 'number' && !Number.isNaN(value) ? value : fallback
  return Math.min(1, Math.max(0, n))
}

/** Null when replay is off. */
export function resolveReplayOptions(
  config: boolean | ReplayConfig | undefined,
): ResolvedReplayOptions | null {
  if (!config) return null
  const cfg = typeof config === 'object' ? config : {}
  const maskAllText = cfg.maskAllText !== false
  // Masking all text implies masking what people type.
  const maskAllInputs = cfg.maskAllInputs !== false || maskAllText
  const seconds =
    typeof cfg.bufferSeconds === 'number' && cfg.bufferSeconds > 0
      ? cfg.bufferSeconds
      : DEFAULT_BUFFER_SECONDS
  const maxChunk =
    typeof cfg.maxChunkBytes === 'number' && cfg.maxChunkBytes > 0
      ? Math.min(cfg.maxChunkBytes, MAX_SERVER_CHUNK_BYTES)
      : DEFAULT_MAX_CHUNK_BYTES
  return {
    sampleRate: rate(cfg.sampleRate, DEFAULT_REPLAY_SAMPLE_RATE),
    onErrorSampleRate: rate(cfg.onErrorSampleRate, DEFAULT_ON_ERROR_SAMPLE_RATE),
    bufferMs: seconds * 1000,
    maskAllText,
    maskAllInputs,
    blockSelector: cfg.blockSelector ?? DEFAULT_BLOCK_SELECTOR,
    maxChunkBytes: maxChunk,
    maskLevel: maskAllText ? 'all' : maskAllInputs ? 'inputs' : 'none',
  }
}

export function recordOptions(
  options: ResolvedReplayOptions,
  emit: RecordOptions['emit'],
  checkoutEveryNms?: number,
): RecordOptions {
  const out: RecordOptions = { emit, maskAllInputs: options.maskAllInputs }
  if (options.maskAllText) out.maskTextSelector = '*'
  if (options.blockSelector) out.blockSelector = options.blockSelector
  if (checkoutEveryNms) out.checkoutEveryNms = checkoutEveryNms
  return out
}

/** Session decision persisted next to `session_id` (only after consent). */
interface ReplayState {
  /** session_id the decision belongs to */
  s: string
  /** `stream` uploads continuously; `buffer` keeps the ring buffer */
  m: 'stream' | 'buffer'
  t: ReplayTrigger
  /** next seq for this session */
  q: number
}

function readState(storage: StorageLike): ReplayState | null {
  try {
    const raw = storage.getItem(REPLAY_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<ReplayState>
    if (typeof v.s !== 'string' || (v.m !== 'stream' && v.m !== 'buffer')) return null
    return {
      s: v.s,
      m: v.m,
      t: v.t === 'error' ? 'error' : 'sampled',
      q: typeof v.q === 'number' && v.q >= 0 ? Math.floor(v.q) : 0,
    }
  } catch {
    return null
  }
}

function writeState(storage: StorageLike, state: ReplayState): void {
  try {
    storage.setItem(REPLAY_KEY, JSON.stringify(state))
  } catch {
    /* quota / blocked storage: the decision lives in memory */
  }
}

export function compressionSupported(): boolean {
  return typeof CompressionStream !== 'undefined'
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new CompressionStream('gzip')
  const writer = stream.writable.getWriter()
  void writer.write(new TextEncoder().encode(text))
  void writer.close()
  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/** Drop query string (except allowlisted params) and fragment from a recorded URL. */
function sanitizeHref(href: string, allow: readonly string[] | undefined): string {
  try {
    const url = new URL(href)
    return `${url.origin}${url.pathname}${filterQuery(url.search, allow)}`
  } catch {
    return ''
  }
}

interface Item {
  json: string
  ts: number
}

interface Segment {
  start: number
  items: Item[]
}

interface PendingChunk {
  items: Item[]
  trigger: ReplayTrigger
  hasError: boolean
  sessionId: string
  userId: string
  anonymousId: string
  epoch: number
}

export interface ReplayIdentity {
  sessionId: string
  userId: string | null
  anonymousId: string | null
}

export interface ReplayHost {
  project: string
  storage: StorageLike
  transport: TransportConfig
  includeQueryParams?: readonly string[] | undefined
  identity(): ReplayIdentity
  /** Called on user input seen by the recorder (session idle tracking). */
  activity?(): void
}

export interface ReplayRecorder {
  /** Consent is granted: decide sampling for this session and start recording. Idempotent. */
  start(): void
  /** Consent withdrawn: stop and drop buffers; `forget` also removes the stored decision. */
  stop(forget: boolean): void
  /** Called before the session id changes: upload what is pending, then stop. */
  endSession(): void
  /** An `$exception` was captured in this session. */
  errorCaptured(): void
  /** Upload the pending streaming chunk and wait for uploads in flight. */
  flush(): Promise<void>
  shutdown(): Promise<void>
  /** Current mode, for tests and debugging. */
  readonly mode: 'idle' | 'buffer' | 'stream' | 'off'
}

export const loadRecord = async (): Promise<RecordFn> => {
  const mod = await import('./rrweb-record.js')
  return mod.record as unknown as RecordFn
}

/**
 * Session replay on top of rrweb `record()`.
 *
 * - Sampling is decided once per session_id and stored with it.
 * - Sampled sessions stream chunks (`trigger: sampled`) every 10 s or when the
 *   gzip size would pass `maxChunkBytes`.
 * - Unsampled sessions keep the last `bufferMs` in memory, starting at a
 *   full-snapshot checkout so the buffer plays on its own. On the first
 *   captured error, with probability `onErrorSampleRate`, the buffer is
 *   uploaded (`trigger: error`) and the session streams from then on.
 */
export function createReplayRecorder(
  options: ResolvedReplayOptions,
  host: ReplayHost,
  load: () => Promise<RecordFn> = loadRecord,
): ReplayRecorder {
  const storage = host.storage
  let mode: ReplayRecorder['mode'] = 'idle'
  let trigger: ReplayTrigger = 'sampled'
  let hasError = false
  let errorRolled = false
  /** Page-lifetime kill switch: no CompressionStream, or rrweb failed to load or start. */
  let unsupported = !compressionSupported()
  /** The server said stop (quota, not enabled, auth); cleared when a new session starts. */
  let stopped = false
  const off = () => unsupported || stopped
  let closed = false
  /** Bumped whenever a recorder must not start (stop / endSession / restart). */
  let generation = 0
  /** Bumped on consent withdrawal: queued chunks from before are dropped. */
  let epoch = 0
  let recordFn: RecordFn | null = null
  let loading: Promise<RecordFn> | null = null
  let stopRecorder: (() => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let segments: Segment[] = []
  let pending: Item[] = []
  let pendingBytes = 0
  let ratio = INITIAL_RATIO
  /** Compression is serialised so seq follows time order. */
  let chain: Promise<void> = Promise.resolve()
  const inflight = new Set<Promise<void>>()
  const seqBySession = new Map<string, number>()

  const report = (error: unknown) => {
    try {
      host.transport.onError?.(error)
    } catch {
      // never throw into the host app
    }
  }

  const onEvent = (event: RrwebEvent, isCheckout?: boolean) => {
    if (closed || off() || mode === 'idle' || mode === 'off') return
    if (event.type === INCREMENTAL_EVENT && host.activity) {
      const source = (event.data as { source?: unknown } | undefined)?.source
      if (typeof source === 'number' && USER_INPUT_SOURCES.has(source)) host.activity()
    }
    if (event.type === META_EVENT && event.data && typeof event.data === 'object') {
      const data = event.data as { href?: unknown }
      if (typeof data.href === 'string') data.href = sanitizeHref(data.href, host.includeQueryParams)
    }
    let json: string
    try {
      json = JSON.stringify(event)
    } catch {
      return
    }
    const item: Item = { json, ts: event.timestamp }
    if (mode === 'buffer') {
      const last = segments[segments.length - 1]
      if (isCheckout || !last) segments.push({ start: event.timestamp, items: [item] })
      else last.items.push(item)
      trimBuffer(event.timestamp)
      return
    }
    pending.push(item)
    pendingBytes += json.length + 1
    if (pendingBytes >= options.maxChunkBytes * ratio) flushPending()
  }

  /** Keep the newest checkout that starts at or before the window, and all after it. */
  const trimBuffer = (now: number) => {
    const cutoff = now - options.bufferMs
    while (segments.length > 1 && segments[1]!.start <= cutoff) segments.shift()
  }

  const startRecorder = () => {
    if (off() || closed || stopRecorder) return
    const gen = generation
    const begin = (record: RecordFn) => {
      if (gen !== generation || off() || closed || stopRecorder) return
      if (mode !== 'buffer' && mode !== 'stream') return
      // Two checkouts per window keep a full snapshot within bufferMs of now.
      const checkout = mode === 'buffer' ? Math.max(1000, Math.floor(options.bufferMs / 2)) : undefined
      try {
        stopRecorder = record(recordOptions(options, onEvent, checkout)) ?? null
      } catch (err) {
        disable(true)
        report(err)
      }
      if (mode === 'stream') ensureTimer()
    }
    if (recordFn) {
      begin(recordFn)
      return
    }
    loading ??= load()
    loading.then(
      (record) => {
        recordFn = record
        begin(record)
      },
      (err: unknown) => {
        loading = null
        disable(true)
        report(err)
      },
    )
  }

  const haltRecorder = () => {
    generation++
    if (stopRecorder) {
      try {
        stopRecorder()
      } catch {
        // rrweb teardown errors are not the host's problem
      }
      stopRecorder = null
    }
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const ensureTimer = () => {
    if (timer || closed) return
    timer = setInterval(flushPending, CHUNK_INTERVAL_MS)
    const t = timer as unknown as { unref?: () => void }
    t.unref?.()
  }

  const disable = (permanent: boolean) => {
    if (permanent) unsupported = true
    else stopped = true
    haltRecorder()
    mode = 'off'
    segments = []
    pending = []
    pendingBytes = 0
  }

  const persist = (patch: Partial<ReplayState>) => {
    const { sessionId } = host.identity()
    const current = readState(storage)
    const base: ReplayState =
      current && current.s === sessionId ? current : { s: sessionId, m: 'buffer', t: 'sampled', q: 0 }
    writeState(storage, { ...base, ...patch })
  }

  /** Next seq for a session. Re-read from storage so tabs sharing a session rarely collide. */
  const allocSeq = (sessionId: string): number => {
    const stored = readState(storage)
    let seq = seqBySession.get(sessionId) ?? 0
    if (stored && stored.s === sessionId) seq = Math.max(seq, stored.q)
    seqBySession.set(sessionId, seq + 1)
    if (stored && stored.s === sessionId) writeState(storage, { ...stored, q: seq + 1 })
    return seq
  }

  const snapshot = (items: Item[], chunkTrigger: ReplayTrigger, chunkHasError: boolean): PendingChunk => {
    const id = host.identity()
    return {
      items,
      trigger: chunkTrigger,
      hasError: chunkHasError,
      sessionId: id.sessionId,
      userId: id.userId ?? '',
      anonymousId: id.anonymousId ?? '',
      epoch,
    }
  }

  const flushPending = () => {
    if (pending.length === 0) return
    const chunk = snapshot(pending, trigger, hasError)
    pending = []
    pendingBytes = 0
    enqueue(chunk)
  }

  const enqueue = (chunk: PendingChunk) => {
    chain = chain.then(() => upload(chunk)).catch(report)
  }

  /** gzip the items, halving until each part fits `maxChunkBytes` (a single event may not). */
  const compress = async (items: Item[]): Promise<Array<{ gz: Uint8Array; items: Item[] }>> => {
    const json = `[${items.map((i) => i.json).join(',')}]`
    const gz = await gzip(json)
    if (gz.length > 0) ratio = Math.min(20, Math.max(2, json.length / gz.length))
    if (gz.length <= options.maxChunkBytes || items.length === 1) return [{ gz, items }]
    const mid = Math.ceil(items.length / 2)
    return [...(await compress(items.slice(0, mid))), ...(await compress(items.slice(mid)))]
  }

  const upload = async (chunk: PendingChunk): Promise<void> => {
    if (off() || chunk.epoch !== epoch || chunk.items.length === 0) return
    const parts = await compress(chunk.items)
    for (const part of parts) {
      if (off() || chunk.epoch !== epoch) return
      if (part.gz.length > MAX_SERVER_CHUNK_BYTES) {
        report(
          new LumenPulseError(
            `lumen-pulse replay upload failed: event of ${part.gz.length} gzip bytes is over the chunk limit`,
            413,
            'REPLAY_CHUNK_TOO_LARGE',
            part.items.length,
          ),
        )
        continue
      }
      const body: ReplayChunk = {
        project: host.project,
        session_id: chunk.sessionId,
        seq: allocSeq(chunk.sessionId),
        started_at: new Date(part.items[0]!.ts).toISOString(),
        ended_at: new Date(part.items[part.items.length - 1]!.ts).toISOString(),
        mask_level: options.maskLevel,
        trigger: chunk.trigger,
        has_error: chunk.hasError,
        user_id: chunk.userId,
        anonymous_id: chunk.anonymousId,
        data: toBase64(part.gz),
      }
      // Requests start right away; only compression waits in line.
      const send = postWithRetry(
        REPLAY_PATH,
        JSON.stringify(body),
        part.items.length,
        host.transport,
        'replay upload',
      ).then((error) => {
        if (!error) return
        if ((error.code && STOP_CODES.has(error.code)) || error.status === 401 || error.status === 403) {
          disable(false)
        }
        report(error)
      })
      inflight.add(send)
      void send.finally(() => inflight.delete(send))
    }
  }

  const switchToStreaming = () => {
    trigger = 'error'
    hasError = true
    persist({ m: 'stream', t: 'error' })
    const items = segments.flatMap((s) => s.items)
    segments = []
    mode = 'stream'
    if (items.length > 0) enqueue(snapshot(items, 'error', true))
    // Restart without checkouts: a fresh full snapshot continues the buffer,
    // and streaming does not pay for a full snapshot every half window.
    if (stopRecorder) {
      haltRecorder()
      startRecorder()
    }
  }

  const reset = () => {
    haltRecorder()
    mode = off() ? 'off' : 'idle'
    segments = []
    pending = []
    pendingBytes = 0
    trigger = 'sampled'
    hasError = false
    errorRolled = false
  }

  return {
    get mode() {
      return mode
    },

    start() {
      if (off() || closed || typeof window === 'undefined') return
      if (mode !== 'idle') return
      const { sessionId } = host.identity()
      let state = readState(storage)
      if (!state || state.s !== sessionId) {
        state = {
          s: sessionId,
          m: Math.random() < options.sampleRate ? 'stream' : 'buffer',
          t: 'sampled',
          q: 0,
        }
      }
      writeState(storage, state)
      mode = state.m
      trigger = state.t
      hasError = state.t === 'error'
      startRecorder()
    },

    stop(forget) {
      epoch++
      reset()
      if (forget) {
        try {
          storage.removeItem(REPLAY_KEY)
        } catch {
          /* blocked storage */
        }
      }
    },

    endSession() {
      if (mode === 'stream') flushPending()
      stopped = false
      reset()
    },

    errorCaptured() {
      if (closed || off()) return
      if (mode === 'stream') {
        // The pending chunk and every later one carry has_error.
        hasError = true
        flushPending()
        return
      }
      if (mode !== 'buffer' || errorRolled) return
      errorRolled = true
      if (Math.random() >= options.onErrorSampleRate) return
      switchToStreaming()
    },

    async flush() {
      flushPending()
      await chain
      await Promise.all([...inflight])
    },

    async shutdown() {
      if (mode === 'stream') flushPending()
      closed = true
      haltRecorder()
      segments = []
      await chain
      await Promise.all([...inflight])
    },
  }
}
