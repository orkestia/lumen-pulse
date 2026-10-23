import { SESSION_KEY, type StorageLike } from './storage.js'

/** Last activity (epoch ms) of the stored session. Written only after consent. */
export const SESSION_LAST_KEY = 'lumen_pulse.session_last'
/** Start (epoch ms) of the stored session, for the max-length cap. Written only after consent. */
export const SESSION_START_KEY = 'lumen_pulse.session_start'

export const DEFAULT_SESSION_TIMEOUT_MINUTES = 30
export const DEFAULT_SESSION_MAX_HOURS = 24
/** `session_last` is rewritten at most this often; far below any timeout. */
export const ACTIVITY_WRITE_THROTTLE_MS = 5_000

export interface SessionClock {
  timeoutMs: number
  maxMs: number
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function resolveSessionClock(
  timeoutMinutes: number | undefined,
  maxHours: number | undefined,
): SessionClock {
  return {
    timeoutMs: positive(timeoutMinutes, DEFAULT_SESSION_TIMEOUT_MINUTES) * 60_000,
    maxMs: positive(maxHours, DEFAULT_SESSION_MAX_HOURS) * 3_600_000,
  }
}

export interface SessionTimes {
  start: number
  last: number
}

/** Idle for longer than the timeout, or older than the max length. */
export function isExpired(now: number, times: SessionTimes, clock: SessionClock): boolean {
  return now - times.last > clock.timeoutMs || now - times.start > clock.maxMs
}

function readTime(storage: StorageLike, key: string): number | null {
  const raw = storage.getItem(key)
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

export interface StoredSession extends SessionTimes {
  id: string
}

/** The persisted session, or null when it is missing or incomplete (e.g. written by v0.3, which had no times). */
export function readSession(storage: StorageLike): StoredSession | null {
  const id = storage.getItem(SESSION_KEY)
  const start = readTime(storage, SESSION_START_KEY)
  const last = readTime(storage, SESSION_LAST_KEY)
  if (!id || start === null || last === null) return null
  return { id, start, last }
}

export function writeSession(storage: StorageLike, session: StoredSession): void {
  storage.setItem(SESSION_KEY, session.id)
  storage.setItem(SESSION_START_KEY, String(session.start))
  storage.setItem(SESSION_LAST_KEY, String(session.last))
}

export function clearSession(storage: StorageLike): void {
  storage.removeItem(SESSION_KEY)
  storage.removeItem(SESSION_START_KEY)
  storage.removeItem(SESSION_LAST_KEY)
}
