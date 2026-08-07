/**
 * Script-tag / auto-boot entry for landings without a bundler.
 *
 *   <script type="module" src="…/auto.js"
 *     data-write-key="…"
 *     data-project="posto-regulado"
 *     data-ingest-url="https://pulse.example.com"
 *     data-consent="granted"></script>
 *
 * Exposes `window.LumenPulse` as the client instance (or factory via create).
 */

import { createLumenPulse } from './client.js'
import type { ConsentStatus, LumenPulseClient, LumenPulseConfig } from './types.js'

export interface LumenPulseGlobal {
  create: typeof createLumenPulse
  client: LumenPulseClient | null
}

declare global {
  interface Window {
    LumenPulse?: LumenPulseGlobal
  }
}

function readScriptConfig(): Partial<LumenPulseConfig> | null {
  const scripts = typeof document !== 'undefined' ? document.getElementsByTagName('script') : []
  for (let i = scripts.length - 1; i >= 0; i--) {
    const el = scripts[i]
    if (!el) continue
    const writeKey = el.getAttribute('data-write-key')
    const project = el.getAttribute('data-project')
    const ingestUrl = el.getAttribute('data-ingest-url')
    if (writeKey && project && ingestUrl) {
      const consentAttr = el.getAttribute('data-consent') as ConsentStatus | null
      const cfg: LumenPulseConfig = { writeKey, project, ingestUrl }
      if (consentAttr === 'granted' || consentAttr === 'denied' || consentAttr === 'unknown') {
        cfg.consent = consentAttr
      }
      if (el.getAttribute('data-autocapture') === 'true') cfg.autocapturePageViews = true
      const org = el.getAttribute('data-organization-uuid')
      if (org) cfg.organizationUuid = org
      return cfg
    }
  }
  return null
}

const api: LumenPulseGlobal = {
  create: createLumenPulse,
  client: null,
}

const auto = readScriptConfig()
if (auto && auto.writeKey && auto.project && auto.ingestUrl) {
  api.client = createLumenPulse(auto as LumenPulseConfig)
}

if (typeof window !== 'undefined') {
  window.LumenPulse = api
}

export { createLumenPulse }
export default api
