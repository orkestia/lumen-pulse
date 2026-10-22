export type UserAgentClass = 'mobile' | 'desktop' | 'bot' | 'unknown'

export function classifyUserAgent(ua: string | undefined): UserAgentClass {
  if (!ua) return 'unknown'
  const s = ua.toLowerCase()
  if (/bot|crawl|spider|slurp|facebookexternalhit|preview/i.test(s)) return 'bot'
  if (/mobi|iphone|android|ipad|tablet/i.test(s)) return 'mobile'
  return 'desktop'
}

export interface ContextOptions {
  appVersion?: string | undefined
  includeQueryParams?: readonly string[] | undefined
}

export function defaultContext(options: ContextOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    user_agent_class: classifyUserAgent(
      typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    ),
  }
  if (typeof location !== 'undefined') {
    out.path = currentPath(options.includeQueryParams)
    out.referrer =
      typeof document !== 'undefined' ? stripQuery(document.referrer) || undefined : undefined
    out.locale =
      typeof navigator !== 'undefined' ? navigator.language || undefined : undefined
    out.utm = parseUtm(location.search)
  }
  if (options.appVersion) out.app_version = options.appVersion
  return out
}

/**
 * `location.pathname`, plus only the query params matched by `allow`.
 * Patterns are exact names or a prefix glob ending in `*` (e.g. `utm_*`).
 * With no allowlist the query string is never sent.
 */
export function currentPath(allow?: readonly string[]): string {
  if (typeof location === 'undefined') return ''
  return `${location.pathname}${filterQuery(location.search, allow)}`
}

export function filterQuery(search: string, allow?: readonly string[]): string {
  if (!allow || allow.length === 0 || !search || search === '?') return ''
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  const kept = new URLSearchParams()
  for (const [k, v] of params.entries()) {
    if (allow.some((pattern) => matchesParam(pattern, k))) kept.append(k, v)
  }
  const out = kept.toString()
  return out ? `?${out}` : ''
}

function matchesParam(pattern: string, name: string): boolean {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))
  return pattern === name
}

/** Drop query string and fragment from a URL (referrers can carry tokens). */
function stripQuery(url: string): string {
  if (!url) return ''
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

export function parseUtm(search: string): Record<string, string> | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  const utm: Record<string, string> = {}
  for (const [k, v] of params.entries()) {
    if (k.startsWith('utm_') && v) utm[k] = v
  }
  return Object.keys(utm).length ? utm : undefined
}
