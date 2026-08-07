const ANON_KEY = 'lumen_pulse.anonymous_id'
const SESSION_KEY = 'lumen_pulse.session_id'
const CONSENT_KEY = 'lumen_pulse.consent'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function memoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

export function resolveStorage(explicit?: StorageLike | null): StorageLike {
  if (explicit === null) return memoryStorage()
  if (explicit) return explicit
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* private mode / blocked */
  }
  return memoryStorage()
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export { ANON_KEY, SESSION_KEY, CONSENT_KEY }
