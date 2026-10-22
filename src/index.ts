/**
 * @orkestia/lumen-pulse — framework-agnostic product-analytics client.
 *
 * Inject into any UI (React, Vue, vanilla, Astro landings) without framework adapters.
 *
 *   import { createLumenPulse } from '@orkestia/lumen-pulse'
 *   const pulse = createLumenPulse({ writeKey, project, ingestUrl })
 *   pulse.setConsent('granted')
 *   pulse.track('page_view')
 *   pulse.identify(userId)
 */

export { createLumenPulse } from './client.js'
export type {
  AutocaptureConfig,
  ConsentStatus,
  LumenPulseClient,
  LumenPulseConfig,
  PulseContext,
  PulseEvent,
  SignalKind,
  TrackProperties,
} from './types.js'
export { classifyUserAgent, filterQuery, parseUtm } from './context.js'
export { LumenPulseError } from './transport.js'
export { memoryStorage } from './storage.js'
