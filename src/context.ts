export type UserAgentClass = 'mobile' | 'desktop' | 'bot' | 'unknown'

export function classifyUserAgent(ua: string | undefined): UserAgentClass {
  if (!ua) return 'unknown'
  const s = ua.toLowerCase()
  if (/bot|crawl|spider|slurp|facebookexternalhit|preview/i.test(s)) return 'bot'
  if (/mobi|iphone|android|ipad|tablet/i.test(s)) return 'mobile'
  return 'desktop'
}

export function defaultContext(appVersion?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    user_agent_class: classifyUserAgent(
      typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    ),
  }
  if (typeof location !== 'undefined') {
    out.path = `${location.pathname}${location.search}`
    out.referrer = typeof document !== 'undefined' ? document.referrer || undefined : undefined
    out.locale =
      typeof navigator !== 'undefined' ? navigator.language || undefined : undefined
    out.utm = parseUtm(location.search)
  }
  if (appVersion) out.app_version = appVersion
  return out
}

export function parseUtm(search: string): Record<string, string> | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  const utm: Record<string, string> = {}
  for (const [k, v] of params.entries()) {
    if (k.startsWith('utm_') && v) utm[k] = v
  }
  return Object.keys(utm).length ? utm : undefined
}
