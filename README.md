# @ltinteg/lumen-pulse

Framework-agnostic **Lumen Pulse** client — inject product analytics into any UI
(React, Vue, vanilla, Astro landings, …) without framework adapters.

Tracks **anonymous** and **authenticated** behavior with consent gating and
`identity.alias` stitch. Speaks Lumen-compatible contracts (`signal_kind: product`,
project write-key, org/project fields).

> **License:** [source-available](./LICENSE) — source is open for audit and
> authorized Internal Use. **Redistribution is prohibited** (not OSI open source).
> Package publishes are restricted.

## Install

```bash
# from GitHub (preferred while private/restricted)
npm i github:ltinteg/ltinteg-lumen-pulse

# or local path in the monorepo checkout
npm i ../ltinteg-lumen-pulse
```

Do not republish this package to a public registry.

## Quickstart (bundled app)

```ts
import { createLumenPulse } from '@ltinteg/lumen-pulse'

const pulse = createLumenPulse({
  writeKey: 'lump_…',           // Pulse product key (not lumk_ collector)
  project: 'posto-regulado',    // or faladelivery, …
  ingestUrl: 'https://pulse.example.com', // or same-origin API
})

// after your cookie banner:
pulse.setConsent('granted')

pulse.track('page_view')
pulse.track('cta_clicked', { cta: 'waitlist' })

// after login / signup:
pulse.identify(userId, { org_id: orgId })

await pulse.flush() // optional; batches flush automatically
```

## Script-tag (landing, no bundler)

```html
<script
  type="module"
  src="https://your-cdn.example/lumen-pulse/auto.js"
  data-write-key="lump_…"
  data-project="posto-regulado"
  data-ingest-url="https://pulse.example.com"
  data-consent="granted"
  data-autocapture="true"
></script>
<script type="module">
  // window.LumenPulse.client is ready when data-* attrs were present
  window.LumenPulse?.client?.track('cta_clicked', { cta: 'hero' })
</script>
```

## API

| Method | Purpose |
|--------|---------|
| `track(name, props?, context?)` | Queue a product event |
| `identify(userId, traits?)` | Set `user_id` and emit `identity.alias` |
| `setConsent('granted'\|'denied'\|'unknown')` | LGPD gate; no events until `granted` |
| `reset()` | New anonymous/session after logout |
| `flush()` | Send queued events now |
| `shutdown()` | Flush and stop timer |
| `getAnonymousId()` / `getSessionId()` | Inspect ids |

## Event envelope (wire)

Every event includes `signal_kind: "product"`, `anonymous_id` (when consented),
optional `user_id`, `session_id`, `project`, `properties`, and `context`
(path, referrer, utm, locale, consent, …). See `src/types.ts`.

Ingest target: `POST {ingestUrl}/api/product/ingest/batch` with
`X-Api-Key: <lump_…>` (and `Authorization: Bearer <lump_…>`).

## Repo status

Injectable **client SDK** on branch `feat/pulse-sdk-align`. Product ingest API
currently lives temporarily in `ltinteg-api-lumen` (`/api/product/*`); a dedicated
Pulse service may extract later. See ltinteg-memory
`docs/features/lumen-pulse-federation-implementation-plan.md`.

## Development

```bash
npm install
npm test
npm run build
```

## Related

- Lumen ops observability: `ltinteg-api-lumen` / `ltinteg-app-lumen` (do not send
  product clicks into log/error pipelines)
- Memory design: `ltinteg-memory/docs/ideas/lumen-product-analytics.md`
