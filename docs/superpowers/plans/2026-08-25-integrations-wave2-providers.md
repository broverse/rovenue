# Integrations Wave-2 Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the final six providers (Braze, OneSignal, Iterable, Airbridge, Singular, Discord) plus Wave-1 parked cleanup — zero schema migrations, closing ROADMAP §6.

**Architecture:** Each provider is a registry entry on the proven fanout→deliver pipeline. Identity enrichment, the 17-key catalog, declarative credential fields, validate-notes, skipReason UI, and DRAWER_IDS invariants all exist. Slack's message builder hoists into a shared chat module reused by Discord.

**Tech Stack:** Hono/TS, Drizzle/Postgres, BullMQ, undici, Zod, Vitest, React, Fumadocs.

**Spec:** `docs/superpowers/specs/2026-08-25-integrations-wave2-providers-design.md` (Wave-1 spec's conventions bind wherever unstated: `docs/superpowers/specs/2026-08-24-integrations-wave1-providers-design.md`)

## Global Constraints

- NEVER create/switch branches or worktrees; commit on current HEAD (main). Conventional commits.
- TS strict; no magic values; zero schema migrations; `{ data }`/`{ error }` envelopes.
- Test throttle (user directive, binding): full/multi-suite runs = `nice -n 19 npx vitest run --maxWorkers=2`; builds = `nice -n 19 pnpm build --concurrency=2`; suites strictly sequential; single-file runs get the `nice -n 19` prefix. `docker ps` before real-infra tests (vitest hangs when Docker is down); run api tests from `/Volumes/Development/rovenue/apps/api`.
- Provider skeleton conventions (mirror `apps/api/src/services/integrations/providers/slack.ts` / `appsflyer.ts` / `amplitude.ts` as fits): `allowMultipleConnections: false`, no `retryPolicy`, `mapEvent` throws on empty `outboxEventId` (Slack-style exception only where a body has no dedup field — justify in code), `defaultEventMapping: DEFAULT_EVENT_MAPPING.<ID>` single-source, catalogs from shared consts, ATT gate NEVER re-implemented (upstream in enrich-envelope.ts).
- New reserved attribute keys (exact): `$onesignalId`, `$brazeAliasName`, `$iterableUserId`, `$airbridgeDeviceId`, `$singularDeviceId`.
- Credential field ids are LOCKED by Task 2's map — provider schemas must match byte-exact; drift is review-blocking.
- Vendor endpoints are design-time references — verify via time-boxed WebFetch; unreachable docs get flagged, never guessed silently. Zero-footprint validation preferred; probes disclosed via `PROVIDER_VALIDATE_NOTES`; shape-only allowed only where no real check exists (documented "first delivery is the proof").
- Dashboard invariants from Wave 1 must stay green: DRAWER_IDS↔DRAWER_APPS set-equality and CARD_ID_TO_PROVIDER↔DRAWER_IDS tests force every new card to be wired or fail.
- Docs pages: Wave-1 template; every page states "events, not profile sync"; MDX gotcha — no bare `{{...}}`/`{...}` in prose.

---

### Task 1: Wave-1 parked cleanup + const rename

**Files:**
- Modify: `packages/shared/src/integrations.ts` (rename `WAVE1_PROVIDER_EVENT_KEYS` → `STANDARD_PROVIDER_EVENT_KEYS`; keep everything else), `packages/shared/src/index.ts` (re-export)
- Modify: every consumer of the old name (grep; providers + step-events + tests)
- Modify: `apps/api/src/services/integrations/event-mapping.ts` (type `DEFAULT_EVENT_MAPPING` as `Readonly<Record<IntegrationProviderId, Readonly<Partial<Record<RovenueEventKey, string>>>>>`; `IntegrationProvider.defaultEventMapping` in `types.ts` gains the matching `Readonly<...>`)
- Modify (comment-only): `apps/api/src/services/integrations/providers/mixpanel.ts:32` (drop the false "kept in sync deliberately" — the set is shared) and the orphan "Default event mapping" banner ~lines 71-79; `meta-capi.ts:79-83` + `tiktok-events.ts:77-81` ("above" → "in event-mapping.ts's DEFAULT_EVENT_MAPPING"); `apps/api/src/services/webhook-processor.ts` C2-fallback comment gains "no live caller reaches the purchase-keyed branch today — webhookEventId is required on the only production path"; `apps/api/src/services/integrations/backfill.integration.test.ts:534` comment name updated to `SUBSCRIPTION_BRIDGE_EVENT_KEYS`

**Interfaces:**
- Produces: `STANDARD_PROVIDER_EVENT_KEYS` (same value/order as the old const) — every Wave-2 provider consumes it.

- [ ] **Step 1:** Rename + Readonly typing + the six comment fixes. `grep -rn "WAVE1_PROVIDER_EVENT_KEYS"` across apps/packages must return zero after.
- [ ] **Step 2:** Run: `nice -n 19 npx vitest run` on the touched test files (shared integrations tests, provider tests, step-events test) + `cd apps/api && npx tsc --noEmit` + dashboard typecheck. Everything green with NO test-logic changes (rename-only edits in tests are fine).
- [ ] **Step 3:** Commit `refactor(integrations): wave-1 parked cleanup; STANDARD_PROVIDER_EVENT_KEYS; readonly mappings`

---

### Task 2: Reserved attributes + locked credential fields

**Files:**
- Modify: `packages/shared/src/attributes/catalog.ts` (five `def(key, ok)` entries under the vendor-ids banner), its test
- Modify: `apps/docs/content/docs/integrations/subscriber-identity-attributes.mdx` (five rows)
- Modify: `apps/dashboard/src/components/apps/integration-drawer/step-credentials.tsx` (`PROVIDER_CREDENTIAL_FIELDS` gains all six Wave-2 entries), its test

**Interfaces:**
- Produces (locked — providers must match exactly):

```ts
BRAZE: [{ id: "rest_api_key", label: "REST API key", secret: true }, { id: "rest_endpoint", label: "REST endpoint", placeholder: "https://rest.iad-01.braze.com" }],
ONESIGNAL: [{ id: "app_id", label: "App ID" }, { id: "rest_api_key", label: "REST API key", secret: true }],
ITERABLE: [{ id: "api_key", label: "API key", secret: true }, { id: "region", label: "Region (us or eu)", optional: true, placeholder: "us" }],
AIRBRIDGE: [{ id: "app_name", label: "App name" }, { id: "api_token", label: "API token", secret: true }],
SINGULAR: [{ id: "sdk_key", label: "SDK key", secret: true }],
DISCORD: [{ id: "webhook_url", label: "Incoming webhook URL", secret: true, placeholder: "https://discord.com/api/webhooks/..." }],
```

- [ ] **Step 1: TDD** — catalog tests (five keys accept, 501-char reject) then entries; step-credentials test (a Wave-2 provider renders its fields) then the map rows.
- [ ] **Step 2:** Docs rows; `nice -n 19 pnpm --filter @rovenue/docs build` green.
- [ ] **Step 3:** Run shared + dashboard step tests + typechecks; green. Commit `feat(integrations): wave-2 vendor-id attributes + locked credential fields`

---

### Task 3: Chat message builder hoist (Slack → shared, Discord-ready)

**Files:**
- Create: `apps/api/src/services/integrations/chat-message.ts` + `chat-message.test.ts`
- Modify: `apps/api/src/services/integrations/providers/slack.ts` (consume the shared module; delete the local builder)

**Interfaces:**
- Produces (moved verbatim from slack.ts — same names so Slack's imports barely change):

```ts
export interface ChatMessageInput { eventKey: RovenueEventKey; amount?: string; currency?: string; productId?: string; subscriberId?: string; }
export function buildChatMessageText(input: ChatMessageInput): string;   // body of today's buildSlackMessageText, byte-identical output
export function maskSubscriberId(subscriberId: string): string;          // moved as-is
```

- Slack keeps thin aliases if its tests import the old names (`buildSlackMessageText = buildChatMessageText`) OR its tests update imports — implementer picks the smaller diff; either way **Slack's message-output assertions stay unmodified and green** (that is the byte-identical proof, spec acceptance 3).

- [ ] **Step 1:** Move + rewire; chat-message.test.ts hosts the per-family + PII-absence tests (moved from slack.test.ts or referenced — no duplicated assertions in two files; slack.test.ts keeps provider-level tests).
- [ ] **Step 2:** Run slack + chat-message tests + tsc; green with Slack output assertions untouched. Commit `refactor(integrations): hoist chat message builder for multi-provider reuse`

---

### Tasks 4–9: The six providers (one task each; Wave-1 per-provider gate structure)

Each task = provider file + unit tests (TDD), registry entry, `IntegrationProviderId` member, dashboard AppDescriptor + i18n + drawer wiring (DRAWER_IDS/DRAWER_APPS/CARD_ID_TO_PROVIDER — invariant tests enforce), docs page + meta.json, PROVIDER_VALIDATE_NOTES where the spec demands. Battery per task: provider+registry tests, dashboard suite, docs build, tsc ×2 — all with the throttle discipline. Commit `feat(integrations): <provider> first-class provider`.

**Task 4: BRAZE** — `providers/braze.ts`. First **lifecycle**-category provider: activate the category (rail/homepage/i18n ONCE; `CategoryId` union + format ordering already carry `lifecycle`). Topics revenue+subscription; catalog `STANDARD_PROVIDER_EVENT_KEYS`; mapping: revenue.* → purchases entries, lifecycle keys → `rovenue_<suffix>` custom events (names in `DEFAULT_EVENT_MAPPING.BRAZE`). Wire: `POST {rest_endpoint}/users/track`, auth `Authorization: Bearer rest_api_key`; identity `external_id = subscriberAttributes.appUserId ?? subscriberId`, optional `$brazeAliasName` → `user_alias {alias_name, alias_label: "rovenue"}` used INSTEAD of external_id when appUserId is absent and the alias attribute present; purchases carry `properties: { rovenue_event, outbox_event_id }`; REFUND per vendor docs (verify; fallback = drop REFUND from the default mapping with a comment). Endpoint validation (create AND deliver): https + host regex `^rest\.[a-z0-9-]+\.braze\.(com|eu)$` (named const `BRAZE_ENDPOINT_HOST_RE`) — allowlist matrix test incl. `rest.iad-01.braze.com.evil.example` bypass. Classification: 2xx (Braze returns 201/200 w/ message) ok; 400 non-retriable; 401/403 non-retriable; 429/5xx retriable. validateCredentials: `users/track` probe with FIXED `external_id: "rovenue-credential-probe"` (named const) + one tagged event — Braze-permission-true check per the spec's ruling; `PROVIDER_VALIDATE_NOTES.BRAZE` states one deletable, MAU-countable probe profile is created (single, reused). Docs page: probe-profile note, "events not profile sync", identity section.

**Task 5: ONESIGNAL** — `providers/onesignal.ts`. Lifecycle category exists after Task 4 — descriptor only. Topics revenue+subscription; catalog standard; REQUIRES `$onesignalId` else skip `no_user_data`. Implementer verifies the contemporary custom-events surface on `api.onesignal.com` (Events API availability vs user-properties update) and implements the documented one; auth header per current docs (`Authorization: Key <rest_api_key>` or Basic — verify); `app_id` in path/body per contract; outboxEventId carried in the event payload. Classification: 2xx ok; 400/401/403 non-retriable; 429/5xx retriable. validateCredentials: `GET /apps/{app_id}` (or `view app` equivalent) — REAL zero-footprint; no validate note. Docs page states which surface (events vs properties) is used and why.

**Task 6: ITERABLE** — `providers/iterable.ts`. Lifecycle descriptor. Topics revenue+subscription; identity `subscriberAttributes.$iterableUserId ?? identityContext.email ?? subscriberAttributes.$email` else skip `no_user_data`; revenue.* → `POST /api/commerce/trackPurchase` (user {email|userId}, items [{id: productId ?? "unknown", name: productId ?? providerEvent, price: amount float, quantity: 1}], total, createdAt ms, id: outboxEventId) — REFUND per vendor docs (verify; default negative total w/ citation); lifecycle → `POST /api/events/track` (email|userId, eventName `rovenue_<suffix>`, id: outboxEventId, createdAt). Endpoints const `ITERABLE_ENDPOINTS = { us: "https://api.iterable.com", eu: "https://api.eu.iterable.com" }`; header `Api-Key`. Classification: 200 ok; 400 non-retriable; 401 non-retriable; 429/5xx retriable. validateCredentials: real zero-footprint GET (implementer picks from current docs, e.g. a lists/key-info read) — no validate note. Docs page carries the spec's PLAINTEXT-EMAIL sentence verbatim intent ("your subscribers' email addresses are sent to Iterable as their user key") + events-not-profile-sync.

**Task 7: AIRBRIDGE** — `providers/airbridge.ts`. Attribution descriptor (category exists). Topics revenue+subscription; REQUIRES `$airbridgeDeviceId` else skip `no_user_data`; wire per verified current S2S contract (`api.airbridge.io`, `Authorization: Bearer api_token`, app_name in path/body, eventCategory from mapping values, transactionID = outboxEventId, revenue/currency on revenue.* only, REFUND stance per vendor docs w/ citation or sibling-positive convention documented). Classification: 2xx ok; 400/401/403 non-retriable; 429/5xx retriable. validateCredentials: implementer verifies whether any real check exists (token-validating read); if none → shape-only + AppsFlyer-pattern docs note; state the outcome.

**Task 8: SINGULAR** — `providers/singular.ts`. Attribution descriptor. Topics revenue+subscription; device ladder `$singularDeviceId` → `$idfa` (param `idfa`) → `$gpsAdId` (param `aifa`) → skip `no_user_data` (ATT upstream); wire `https://s2s.singular.net/api/v1/evt` with `a={sdk_key}` + event name + device param + `is_revenue_event=true&amt=&cur=` on revenue.*, outboxEventId in a custom arg. **Secret-in-query constraint (spec):** the provider must never log/persist the request URL; code comment states it; test asserts the DeliveryResult contains no URL. Classification: 200 (body-status per docs — verify) ok; 400/401/403 non-retriable; 429/5xx retriable. validateCredentials: same stance as Airbridge (verify; likely shape-only + docs note).

**Task 9: DISCORD** — `providers/discord.ts`. Communication descriptor (category exists). Topics ALL FOUR; catalog = full `ROVENUE_EVENT_KEYS`; mapping identity-map from the shared const (Slack pattern); messages via `buildChatMessageText` (Task 3) — ZERO new builder code; body `{ content: text }`. URL allowlist (create AND deliver): https + host `discord.com` or `discordapp.com` (named consts) + path starting `/api/webhooks/` — matrix test incl. host-suffix bypass. Classification: 204 ok (Discord returns no content); 200 ok; 404/401/403 non-retriable (`unknown webhook`); 400 non-retriable; 429 retriable; 5xx retriable. validateCredentials: POSTs a real "Rovenue connected ✅" message; `PROVIDER_VALIDATE_NOTES.DISCORD` mirrors Slack's. Docs page: Slack-parity at-least-once duplicate note verbatim + events-not-profile-sync.

---

### Task 10: Verification + ROADMAP §6 close

**Files:**
- Modify: `ROADMAP.md` §6 (Wave 2 shipped w/ spec pointer; §6 remaining gap = store-native passthrough only; Now score to its end-state band with reasoning; top priority-order list re-pointed at the NEXT roadmap item — Flutter SDK)

- [ ] **Step 1: Battery** (throttle discipline; ACTUAL numbers; unrelated reds captured + determinism-checked, not fixed): `nice -n 19 pnpm build --concurrency=2`; `cd apps/api && nice -n 19 npx vitest run --maxWorkers=2`; `VITEST_CONTAINER_PASS=1 nice -n 19 npx vitest run`; db (DATABASE_URL exported) + shared + dashboard suites + docs build — sequential.
- [ ] **Step 2:** ROADMAP edit (stage ONLY ROADMAP.md; never the unrelated dirty files asset-library.tsx / seed.ts). Commit `docs(roadmap): §6 Wave-2 providers shipped` with numbers in body.

---

## Self-review notes (for executors)

- Task 2 locks all credential ids before any provider exists (Wave-1 discipline); Task 3 must land before Task 9 (Discord consumes the shared builder); Task 4 activates lifecycle before Tasks 5-6 add descriptors to it.
- OneSignal/Airbridge/Singular have contract-verification duties — unreachable vendor docs get the Wave-1 flag treatment, never silent guessing. Classifier note for the controller: long provider dispatches have been blocked before; use the file-based dispatch pattern from the start for Tasks 4-9.
- Braze probe-profile ruling and Iterable plaintext-email sentence are spec-binding — reviewers treat their absence as spec ❌.
