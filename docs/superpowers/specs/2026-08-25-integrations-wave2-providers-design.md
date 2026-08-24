# Integrations Wave 2 — Second Provider Set — Design Spec

**Date:** 2026-08-25
**Roadmap area:** §6 Third-party integrations — final sub-project (foundation + Wave 1 shipped 2026-08-24/25)
**Parity bar:** RevenueCat's remaining first-party integration set; RC-compatible attribute naming.

## 1. Context

Everything rides the proven pipeline: registry entry + mapper = a provider; zero migrations; identity
enrichment (ATT-gated) and the 17-key public catalog exist; declarative credential fields,
`PROVIDER_VALIDATE_NOTES`, per-category dashboard plumbing, and the docs-page pattern are all
established by Wave 1 (`2026-08-24-integrations-wave1-providers-design.md` — its conventions bind
this spec wherever unstated). Wave 1's parked minors are folded in here as cleanup.

## 2. Goals

1. Six providers: **Braze, OneSignal, Iterable, Airbridge, Singular, Discord**.
2. New RC-compatible reserved attributes where a vendor needs its own id:
   `$onesignalId`, `$brazeAliasName`, `$iterableUserId`, `$airbridgeDeviceId`, `$singularDeviceId`.
3. Wave-1 parked-minor cleanup (stale comments, `Readonly` typing on DEFAULT_EVENT_MAPPING,
   C2-fallback "no live caller" comment, backfill test comment rename).
4. ROADMAP §6 closed to its target band.

## 3. Non-goals

- Push-notification SENDING through OneSignal/Braze (we forward subscription data; campaign tooling
  stays in the vendor). Discord bots/slash commands (incoming webhook only, Slack parity).
- Web SDK-dependent identity flows; store-native full passthrough (still Wave-1's documented gap).
- The rate-limit 429 test worker-namespacing (latent flake, separate small fix if it bites CI).

## 4. Provider matrix

All mirror the Wave-1 skeleton: `allowMultipleConnections: false`, no `retryPolicy`, mapEvent throws
on empty outboxEventId, mapping single-sourced via `DEFAULT_EVENT_MAPPING.<ID>`, catalogs built from
the shared key consts. Endpoints are design-time references — implementers verify via time-boxed
WebFetch and flag unreachable docs (Wave-1 pattern).

| Provider | Category | Topics | Identity requirement | Credentials | Dedup |
|---|---|---|---|---|---|
| BRAZE | lifecycle (NEW) | revenue, subscription | external_id = `appUserId` ?? subscriberId; optional `$brazeAliasName` → user_alias {alias_name, alias_label: "rovenue"} when no appUserId | `rest_api_key` (secret), `rest_endpoint` (instance URL, https, host allowlist `*.braze.com`/`*.braze.eu`) | none native for purchases — `properties.outbox_event_id` carried; documented at-least-once |
| ONESIGNAL | lifecycle | revenue, subscription | REQUIRES `$onesignalId` else skip `no_user_data` | `app_id`, `rest_api_key` (secret) | event `id` where supported; else properties + documented |
| ITERABLE | lifecycle | revenue, subscription | `$iterableUserId` ?? `$email` (Iterable is user-keyed by email/userId) else skip `no_user_data` | `api_key` (secret), `region` (us/eu optional) | `id` = outboxEventId on events/track; trackPurchase carries `id` |
| AIRBRIDGE | attribution | revenue, subscription | REQUIRES `$airbridgeDeviceId` else skip `no_user_data` | `app_name`, `api_token` (secret) | transactionID = outboxEventId |
| SINGULAR | attribution | revenue, subscription | `$singularDeviceId` ?? `$idfa` ?? `$gpsAdId` else skip (ATT gate upstream as always) | `sdk_key` (secret) | documented per vendor; outboxEventId in payload |
| DISCORD | communication | all four | none | `webhook_url` (secret; https, host exactly `discord.com` or `discordapp.com`, path prefix `/api/webhooks/`) | none — Slack-parity at-least-once note verbatim |

Provider notes (binding):
- **Braze**: `POST {rest_endpoint}/users/track` with `attributes`/`purchases`/`events` arrays;
  revenue.* → a `purchases` entry (product_id, currency, price=amount [REFUND: Braze convention —
  implementer verifies; if none documented, negative price with vendor citation or skip REFUND from
  the default mapping with a comment], time=occurredAt, properties {rovenue_event, outbox_event_id});
  lifecycle keys → custom `events` entries named `rovenue_<suffix>`. Auth `Authorization: Bearer
  rest_api_key`. The instance endpoint is user-supplied — validate https + braze host allowlist at
  create AND deliver (two-phase, Slack pattern). validateCredentials: a real minimal
  `/users/track` probe is Braze's only check — stable dedup via a fixed external_id
  `rovenue-credential-probe` + `PROVIDER_VALIDATE_NOTES.BRAZE` disclosure.
- **ONESIGNAL**: RC-parity behavior is tag/outcome updates keyed by the player/subscription id;
  implement as custom events via the current Events API if available for the account tier —
  implementer verifies the contemporary endpoint (`api.onesignal.com`) and picks events-API if
  present else user-properties update; either way `$onesignalId` is the key and the docs page states
  which surface is used. Auth `Authorization: Basic rest_api_key` (or `Key` header per current docs).
  validateCredentials: GET the app (`/apps/{app_id}`) — real, zero-footprint.
- **ITERABLE**: `POST https://api.iterable.com/api/events/track` (EU `api.eu.iterable.com`) header
  `Api-Key`; revenue.* → `commerce/trackPurchase` (items[{id: productId, name, price, quantity:1}],
  total=amount, user{email|userId}, id=outboxEventId, createdAt) — REFUND per Iterable convention
  (implementer verifies; default: negative total with citation); lifecycle → events/track
  (eventName `rovenue_<suffix>`, id=outboxEventId). validateCredentials: a real zero-footprint GET
  (e.g. lists or key-info endpoint — implementer picks from current docs).
- **AIRBRIDGE**: S2S events API (`api.airbridge.io`), header `Authorization: Bearer api_token`;
  eventCategory from mapping; transactionID + revenue/currency on revenue.*. Shape-only validation
  is NOT acceptable if a real check exists — implementer verifies; if none, AppsFlyer-pattern
  (shape-only + "first delivery is the proof" docs note).
- **SINGULAR**: S2S `https://s2s.singular.net/api/v1/evt` (GET/POST with query params per docs),
  `a={sdk_key}`; revenue via `is_revenue_event=true&amp;amt&amp;cur`; device via `idfa`/`aifa`/custom.
  Same validation stance as Airbridge.
- **DISCORD**: mirror the Slack provider file nearly verbatim: message builder reuse is REQUIRED —
  hoist Wave-1's Slack message-text builder into a shared chat-message module consumed by both
  (don't copy-paste a second 4-family builder); Discord body `{ content }`; classification per
  Discord webhook contract (204 no-content success; 404 unknown webhook non-retriable; 429 with
  retry_after retriable; 5xx retriable). validateCredentials posts a real "Rovenue connected ✅"
  message + PROVIDER_VALIDATE_NOTES.DISCORD.

## 5. Cross-cutting

- Reserved attributes: the five new keys via `def(key, ok)`; docs page updated; enrichment needs no
  change (generic flatten passes them through).
- Dashboard: `lifecycle` is the one NEW category (rail/homepage once, by the Braze task);
  attribution/communication exist. Credential fields extend `PROVIDER_CREDENTIAL_FIELDS` (locked in
  the plan before provider tasks, Wave-1 discipline); each card + i18n + drawer wiring; DRAWER_IDS
  set-equality invariant tests already enforce completeness (Wave-1 fix) — new cards must satisfy
  them.
- Wave-1 parked cleanup task: the four stale comments, `Readonly<Partial<Record<...>>>` typing on
  DEFAULT_EVENT_MAPPING (+ provider field type), C2-fallback comment sentence, backfill test comment
  rename. No behavior changes.
- Docs: one page per provider (Wave-1 template: setup, fields, mapping, identity + attribute link,
  dedup/validation notes). Wave-1's WAVE1_PROVIDER_EVENT_KEYS const: rename or alias to a neutral
  `STANDARD_PROVIDER_EVENT_KEYS` so Wave-2 providers aren't importing a misnamed const (pure rename,
  update consumers).

## 6. Data changes

None. Zero migrations (registry-driven).

## 7. Testing

Wave-1 discipline verbatim: TDD per provider (mapping, skip reasons, identity chains, dedup id,
classification vs vendor-documented shapes via MockAgent, schema cases); host-allowlist matrices for
Braze/Discord; shared chat-builder tests cover both Slack and Discord after the hoist (Slack's
existing tests must stay green); enrichment untouched (its suites are the net); full battery at the
end with the throttle discipline (`nice -n 19`, `--maxWorkers=2`, sequential).

## 8. Acceptance criteria

1. Each provider connectable via the drawer (DRAWER_IDS invariants green), credentials validated by
   a REAL vendor call wherever the vendor offers any (zero-footprint preferred; probes disclosed);
   deliveries carry vendor-side dedup ids where the vendor supports them, documented where not.
2. Identity-gated providers skip with visible reasons (skipReason UI exists).
3. Slack behavior byte-identical after the chat-builder hoist.
4. Zero migrations; full battery green; ROADMAP §6 updated to its end state (Wave 2 shipped;
   remaining §6 gap = store-native passthrough only).
