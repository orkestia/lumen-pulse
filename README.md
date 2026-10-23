# @orkestia/lumen-pulse

Framework-agnostic **Lumen Pulse** client. Add consent-gated product analytics to
any web UI (React, Vue, Svelte, vanilla, static landings) without framework adapters.

It tracks **anonymous** and **authenticated** behaviour, gates everything on
consent, and stitches the two with an `identity.alias` event on login. It can
also send browser errors and record masked [session replays](#session-replay).
The only runtime dependency is `rrweb`, which is loaded on demand and only when
replay is on.

License: [MIT](./LICENSE).

## Install

```bash
npm i github:orkestia/lumen-pulse#v0.4.0
```

The package is installed from GitHub, not from the npm registry. npm runs the
`prepare` script on install, which builds `dist/`.

## Quickstart (bundled app)

```ts
import { createLumenPulse } from '@orkestia/lumen-pulse'

const pulse = createLumenPulse({
  writeKey: 'lump_…',                          // browser Pulse key, never lumk_
  project: 'my-app',                           // the project the key is bound to
  ingestUrl: 'https://lumen-api.orkestia.dev',
  autocapture: { pageViews: 'history' },       // optional: SPA page views
})

// after your cookie banner:
pulse.setConsent('granted')

pulse.track('cta_clicked', { cta: 'signup' })

// after login / signup:
pulse.identify(userId, { org_id: orgId })

// after logout:
pulse.reset()
```

Batches flush every 2 s, when a batch fills, and when the page is hidden or
closed. `await pulse.flush()` sends right away.

## Script tag (no bundler)

Host `dist/auto.js` yourself (for example in your site's static assets). With
session replay on, also host the `dist/auto-rrweb-record-*.js` chunk in the same
folder; `auto.js` fetches it only once replay starts. Copying the whole `dist/`
folder covers both.

```html
<script
  type="module"
  src="/assets/lumen-pulse/auto.js"
  data-write-key="lump_…"
  data-project="my-landing"
  data-ingest-url="https://lumen-api.orkestia.dev"
  data-autocapture="history"
  data-include-query-params="utm_*,ref"
></script>
<script type="module">
  // window.LumenPulse.client exists when the data-* attributes were present
  window.LumenPulse?.client?.setConsent('granted') // from your cookie banner
  window.LumenPulse?.client?.track('cta_clicked', { cta: 'hero' })
</script>
```

| Attribute | Meaning |
|-----------|---------|
| `data-write-key`, `data-project`, `data-ingest-url` | Required. Without all three no client is created |
| `data-consent` | Initial consent: `granted`, `denied` or `unknown` (default) |
| `data-autocapture` | `true` = one `page_view` at boot; `history` = also on SPA navigation |
| `data-include-query-params` | Comma-separated allowlist for `context.path` (see below) |
| `data-organization-uuid` | Optional organization UUID stamped on events |
| `data-capture-errors` | `true` = send uncaught errors (see [Browser errors](#browser-errors)) |
| `data-replay` | `true` = record masked session replays with the defaults (see [Session replay](#session-replay)) |
| `data-replay-sample-rate` | Fraction of sessions recorded from the start, 0 to 1 (default `0.1`) |

## Keys: `lump_` vs `lumk_`

| Prefix | What it is | Where it goes |
|--------|------------|---------------|
| `lump_` | Browser Pulse key. Write-only, bound to allowed origins and projects | Safe in browser bundles and HTML. This SDK only accepts this kind |
| `lumk_` | Server collector key for logs and metrics | **Never in a browser.** Server-side only. Pulse rejects it with `WRONG_KEY_SCOPE` |

A `lump_` key only works from the origins and for the projects it is bound to,
so a copied key cannot write from another site or into another project.

## Consent

Nothing is sent and nothing but the consent choice is stored until consent is
`granted`.

| Consent | Events | Storage |
|---------|--------|---------|
| `unknown` (default) | Dropped | `anonymous_id` and `session_id` kept in memory only |
| `granted` | Sent | `anonymous_id` and `session_id` persisted (localStorage by default) |
| `denied` | Dropped, queue cleared | `anonymous_id` and `session_id` removed |

The choice itself is stored under `lumen_pulse.consent` so it survives reloads.
Pass `storage: null` to keep everything in memory.

## Sessions

A `session_id` ends after **30 minutes without activity** (`sessionTimeoutMinutes`)
or **24 hours after it started** even while active (`sessionMaxHours`). The next
activity then starts a new one. Activity is any tracked event, `identify()`, a
captured error, user input seen by session replay (mouse, scroll, typing,
touch), or the tab becoming visible again. DOM changes alone do not keep a
session alive.

The start and last-activity times follow the same consent rules as
`session_id`: in memory before consent, stored under `lumen_pulse.session_start`
and `lumen_pulse.session_last` once granted, removed on `denied`. Tabs of the
same browser share the stored session: a tab that comes back after another tab
already started a new session joins it. A new session also starts error dedup
and the replay sampling decision over. Sessions stored by v0.3 (no times) are
replaced on the first load of v0.4.

## Privacy defaults

- `context.path` is `location.pathname` with **no query string**. Allow specific
  params with `includeQueryParams: ['utm_*', 'ref']` (exact names or a prefix
  ending in `*`). UTM params are always sent in their own `context.utm` field.
- `context.referrer` drops the query string and fragment.
- Do not put personal data in event properties. The ingest API rejects known PII
  property names with `PULSE_PII_PROPERTY_FORBIDDEN`.

## Configuration

| Option | Default | Purpose |
|--------|---------|---------|
| `writeKey` | required | `lump_…` browser Pulse key |
| `project` | required | Project slug the key is bound to |
| `ingestUrl` | required | `https://lumen-api.orkestia.dev` (or a same-origin proxy) |
| `consent` | `'unknown'` | Initial consent when none is stored |
| `autocapture` | none | `{ pageViews: true }` = one `page_view` at boot; `{ pageViews: 'history' }` = also on `pushState` / `replaceState` / `popstate`, deduplicated by path |
| `autocapturePageViews` | `false` | Older form of `autocapture: { pageViews: true }` |
| `includeQueryParams` | none | Query params allowed into `context.path` |
| `flushIntervalMs` | `2000` | Batch flush interval |
| `maxBatchSize` | `20` | Events per request, capped at 50 |
| `organizationUuid` | none | Stamped on every event |
| `appVersion` | none | Stamped into `context.app_version` |
| `captureErrors` | `false` | `true` or `{ ignore, sampleRate, maxPerMinute, release, environment }`: send uncaught errors (see [Browser errors](#browser-errors)) |
| `replay` | `false` | `true` or `{ sampleRate, onErrorSampleRate, bufferSeconds, maskAllText, maskAllInputs, blockSelector, maxChunkBytes }`: masked session replay (see [Session replay](#session-replay)) |
| `sessionTimeoutMinutes` | `30` | Idle minutes before a new `session_id` (see [Sessions](#sessions)) |
| `sessionMaxHours` | `24` | Hours before a new `session_id` even while active |
| `storage` | localStorage | Where ids persist after consent; `null` = memory |
| `fetch` | global `fetch` | Override for tests or non-browser runtimes |
| `onError` | none | Called when a batch is dropped (never throws into your app) |

## API

| Method | Purpose |
|--------|---------|
| `track(name, props?, context?)` | Queue a product event |
| `identify(userId, traits?)` | Set `user_id` and emit `identity.alias` |
| `captureException(error, extra?)` | Report a handled error as `$exception` (`handled: true`) |
| `setConsent('granted' \| 'denied' \| 'unknown')` | Consent gate; no events until `granted` |
| `reset()` | New anonymous id and session after logout |
| `flush()` | Send queued events now |
| `shutdown()` | Flush, stop the timer and replay recording, remove page listeners and history hooks |
| `getAnonymousId()` / `getSessionId()` | Inspect ids |

## Browser errors

With `captureErrors` on, the SDK listens for uncaught errors (`window`
`error`) and unhandled promise rejections and sends each as the reserved
event **`$exception`**. The Lumen ingest API turns every `$exception` into a
Lumen log entry (redacted, fingerprinted, `audience=code`) under the key's
organization and project, so it shows up as an **error group** next to your
server errors. A slim product event is kept too, so Pulse can count errors per
page and session.

```ts
const pulse = createLumenPulse({
  // …
  appVersion: '1.4.0',
  captureErrors: {
    environment: 'production',
    ignore: ['ResizeObserver loop', /^chrome-extension:/],
    sampleRate: 1,       // 0 to 1
    maxPerMinute: 10,    // default
  },
})

// handled errors: React error boundaries, fetch wrappers, catch blocks
try {
  await save()
} catch (err) {
  pulse.captureException(err, { feature: 'checkout' })
}
```

`$exception` properties:

| Property | Value |
|----------|-------|
| `name` | Error class, e.g. `TypeError`. Non-Error rejections are `UnhandledRejection` |
| `message` | Up to 1000 chars. Thrown strings are the message; plain objects use their `message` or their JSON |
| `stack` | Up to 10000 chars, when the browser gives one. Without an Error object, one frame is built from the event's file, line and column |
| `handled` | `false` for listeners, `true` for `captureException()` |
| `mechanism` | `onerror`, `unhandledrejection` or `manual` |
| `release`, `environment` | From `captureErrors`; `release` defaults to `appVersion` and is also sent as `context.app_version`, which is where the server reads it |
| `count` | Occurrences this event stands for (see below) |

`context.path` follows the same privacy rules as other events (no query string).
`extra` on `captureException()` is merged in but cannot override the fields above.

**Dedup and cap.** Within a session, an error is identified by name, message and
top stack frame. The first occurrence is sent right away with `count: 1`.
Repeats are counted, not sent; one follow-up `$exception` with
`count: <repeats>` goes out at most once a minute per error, and on `flush()`,
page hide and `shutdown()`. Every sent `$exception` (first or follow-up) counts
toward `maxPerMinute` (default 10): a new error over the cap is dropped, a
follow-up over the cap waits. `reset()` and denied consent clear the counts. The
server also caps each session at 10 `$exception` per minute.

**Consent.** Errors follow the same gate as every other event: nothing is
captured or counted before consent is `granted`.

**Delivery.** Errors are sent about 250 ms after they happen rather than at the
next 2 s tick, so an error that kills the page still has a good chance to get
out; errors in the same burst share one request.

**Third-party scripts.** Errors from a script on another origin reach the page
as a bare `Script error.` with no message or stack. The SDK drops these. To get
the real error, serve the script with CORS headers and load it with
`crossorigin="anonymous"`:

```html
<script src="https://cdn.example.com/widget.js" crossorigin="anonymous"></script>
```

**No personal data in messages.** The server redacts emails, CPFs and other
known patterns from message and stack, but do not build error messages from
user input, names or ids in the first place.

**Source maps are not supported yet.** Stacks from minified bundles are stored
as they are. Grouping still works by location (origin, query and chunk hashes
are stripped server-side, so a redeploy does not split groups), but frames are
not symbolicated.

## Session replay

With `replay` on, the SDK records the page with [rrweb](https://github.com/rrweb-io/rrweb)
and uploads masked recordings to Lumen, where your team plays them back next to
the session's events and errors.

```ts
const pulse = createLumenPulse({
  // …
  captureErrors: true,
  replay: {
    sampleRate: 0.1,         // 10% of sessions recorded from the start
    onErrorSampleRate: 1,    // other sessions: upload the last 60 s when an error happens
    bufferSeconds: 60,
    // privacy defaults, shown for clarity:
    maskAllText: true,
    maskAllInputs: true,
    blockSelector: '[data-private]',
  },
})
```

| Option | Default | Purpose |
|--------|---------|---------|
| `sampleRate` | `0.1` | Fraction of sessions recorded from the start |
| `onErrorSampleRate` | `1` | Fraction of the other sessions that upload their buffer when an error is captured |
| `bufferSeconds` | `60` | Seconds kept in memory for sessions that are not sampled |
| `maskAllText` | `true` | Replace all page text with `*`. Also masks inputs |
| `maskAllInputs` | `true` | Replace input values with `*`. Passwords are always masked |
| `blockSelector` | `[data-private]` | Matching elements and their children are not recorded; playback shows an empty box of the same size |
| `maxChunkBytes` | `45000` | Most gzip bytes per upload. base64 makes the request about 60 KB, inside the keepalive budget |

**Privacy defaults.** Out of the box all text and every input value are replaced
with `*` in the browser, before anything is uploaded, and elements marked
`data-private` are not recorded at all. Mark anything sensitive that should not
appear even as a masked shape:

```html
<section data-private>…</section>
```

The recorded page URL keeps only the path and the params allowed by
`includeQueryParams`; the query string and fragment are dropped. Canvas, fonts
and cross-origin iframes are not recorded. Each upload declares its
`mask_level` (`all`, `inputs`, or `none` when both masks are off), and Lumen
rejects `none` unless your plan explicitly allows unmasked replay.

**Consent.** Nothing is recorded, buffered or loaded before consent is
`granted`. rrweb is imported with a dynamic `import()` at that moment, so apps
without replay, and visitors who never consent, never download it (your
bundler puts it in its own lazy chunk; the record-only part is about 60 KB
gzip). Setting consent to `denied` stops recording and drops anything not yet
uploaded; `unknown` stops it too. `reset()` uploads what is pending for the old
session and makes a new sampling decision for the new one.

**Sampling.** The decision is made once per `session_id` and stored next to it
(`lumen_pulse.replay`, only after consent), so a session is recorded the same
way across page loads. When the session rotates (see [Sessions](#sessions)) the
recording stops, what is pending is uploaded under the old session, and a new
recording starts for the new one: new decision, new full snapshot, `seq` from 0.

- **Sampled sessions** stream: a chunk goes out every 10 s, when it reaches
  `maxChunkBytes`, and when the page is hidden or closed.
- **Other sessions** keep the last `bufferSeconds` in memory only (with a full
  page snapshot at the start, so the buffer plays on its own). Nothing is
  uploaded unless an `$exception` is captured (uncaught with `captureErrors`, or
  `captureException()`). Then, with probability `onErrorSampleRate` (rolled
  once per page), the buffer is uploaded and the session streams from then on.
  Every `$exception` carries the `session_id`, so the error group links to the
  replay.

**Upload.** Chunks are gzip-compressed with the browser's `CompressionStream`,
base64-encoded and sent to `POST {ingestUrl}/api/product/replay/chunk` with
the same `lump_` key, in order (`seq` per session). The next `seq` is read from
and written back to storage right before each upload, so tabs sharing a session
take turns. Two tabs uploading in the same instant can still pick the same
`seq` (storage has no atomic increment), and one of the two chunks can then be
lost in playback. Browsers without
`CompressionStream` (older than Chrome 80, Firefox 113, Safari 16.4) skip replay
entirely; analytics and errors still work. Delivery follows the same retry
rule as events. On `403` (for example `REPLAY_NOT_ENABLED`), `401`,
`REPLAY_QUOTA_EXCEEDED` or `REPLAY_UNMASKED_FORBIDDEN`, recording stops for the
rest of the session and `onError` gets the `LumenPulseError`. The last
chunk on page close is best effort: compression is asynchronous, so up to 10 s
can be lost when a tab is killed.

**Retention and pricing.** Recordings are kept **30 days** by default (plans
can extend it), then deleted. Replay is billed by GB stored: each plan includes
an allowance (Free 1 GB, Pro 10 GB, Enterprise 100 GB per month), and storage
above it is charged per GB. When the organization's replay storage cap is
reached, uploads get `REPLAY_QUOTA_EXCEEDED` and the SDK stops recording.

## Delivery

- Requests go to `POST {ingestUrl}/api/product/ingest/batch` with
  `X-Api-Key: lump_…`, using `fetch` with `keepalive` so they survive page
  close. Each request body stays under 64 KB (the browser's keepalive budget);
  larger queues are split. `sendBeacon` is not used because it cannot send the
  key header.
- The queue is flushed on `pagehide` and when the tab becomes hidden.
- Network errors, `5xx` and `429` are retried **once**, after `Retry-After` when
  the server sends it (up to 10 s; longer waits drop the batch) or after a
  0.5 to 1.5 s jittered delay. Other `4xx` and `PULSE_QUOTA_EXCEEDED` are never
  retried. A dropped batch calls `onError` with a `LumenPulseError` carrying
  `status` (0 for network errors), `code` and `dropped`.

```ts
import { createLumenPulse, LumenPulseError } from '@orkestia/lumen-pulse'

createLumenPulse({
  // …
  onError(err) {
    if (err instanceof LumenPulseError && err.code === 'PULSE_ORIGIN_FORBIDDEN') {
      console.warn('Add this origin to the Pulse key')
    }
  },
})
```

## Limits

- **50 events per request** for browser (`lump_`) keys. The SDK never sends more.
- **Events per minute**, enforced org-wide across all keys and projects
  (`PULSE_RATE_LIMITED`, with `Retry-After`).
- **Monthly event quota** per organization (`PULSE_QUOTA_EXCEEDED`).

## Error codes

| Code | HTTP | Meaning | SDK behaviour |
|------|------|---------|---------------|
| `PULSE_AUTH_INVALID` | 401 | Key unknown, revoked or malformed | Drop, `onError` |
| `WRONG_KEY_SCOPE` | 401 | Not a Pulse key (for example a `lumk_` collector key) | Drop, `onError` |
| `PULSE_ORIGIN_FORBIDDEN` | 403 | Page origin not bound to the key, or no `Origin` header | Drop, `onError` |
| `PULSE_PROJECT_FORBIDDEN` | 403 | `project` not bound to the key | Drop, `onError` |
| `PULSE_NOT_PROVISIONED` | 403 | Pulse is not enabled for the organization | Drop, `onError` |
| `PULSE_BATCH_TOO_LARGE` | 413 | More events in one request than the key allows | Drop, `onError` |
| `PULSE_PII_PROPERTY_FORBIDDEN` | 400 | A property name looks like personal data | Drop, `onError` |
| `PULSE_RATE_LIMITED` | 429 | Org-wide events/min exceeded | Retry once after `Retry-After`, then drop |
| `PULSE_QUOTA_EXCEEDED` | 429 | Monthly quota spent | Drop, `onError` |
| `REPLAY_NOT_ENABLED` | 403 | Replay is off for the organization | Stop replay, `onError` |
| `REPLAY_QUOTA_EXCEEDED` | 429 | Monthly replay storage spent | Stop replay, `onError` |
| `REPLAY_UNMASKED_FORBIDDEN` | 400 | `mask_level: none` without the plan allowing it | Stop replay, `onError` |
| `REPLAY_CHUNK_TOO_LARGE` | 413 | One chunk over 512 KB gzip (also raised locally for a single huge event) | Drop chunk, `onError` |

## Content Security Policy

If your site sends a CSP, allow the ingest host:

```
connect-src 'self' https://lumen-api.orkestia.dev
```

If you serve `auto.js` from your own origin, `script-src 'self'` covers it.

## Event envelope (wire)

Every event carries `signal_kind: "product"`, `event_id`, `event_name`,
`occurred_at`, `project`, `anonymous_id` (null before consent), `user_id`,
`session_id`, `properties` and `context` (path, referrer, utm, locale,
user agent class, consent, app version). See `src/types.ts`.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```
