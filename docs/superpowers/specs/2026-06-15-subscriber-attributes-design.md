# Subscriber Attributes — Design Spec

**Date:** 2026-06-15
**Status:** Approved (design); implementation plan pending
**Branch:** `feat/subscriber-attributes`

## Summary

Rovenue already stores arbitrary custom data on a subscriber via the
`subscribers.attributes` jsonb column and two endpoints
(`POST /v1/subscribers/:appUserId/attributes`, `POST /v1/me/attributes`).
Today this is fully unstructured: `z.record(z.unknown())`, shallow flush-level
merge, no reserved keys, no validation, and **no SDK surface** — clients must
call the HTTP endpoints directly.

This work turns attributes into a first-class, well-typed feature:

1. A **curated reserved-attribute catalog** (`$`-prefixed, validated) for the
   data customers commonly need (identity, push tokens, attribution, device/
   consent), alongside **free-form custom string attributes** (RevenueCat-style).
2. **Per-key metadata storage** (`{value, updatedAt, source}`) for correct
   multi-device last-write-wins.
3. A proper **SDK surface** (Rust core + Swift/Kotlin/RN façades) with
   **local-cache + batch-flush** semantics mirroring the existing session-event
   pipeline.

## Decisions (locked during brainstorming)

- **Model:** Reserved (typed/validated) + free-form custom (RevenueCat model).
- **Reserved set in v1:** identity, push tokens, attribution/campaign, device/consent.
- **Custom value type:** `string | null` only (null = delete); key ≤40 chars,
  value ≤500 chars, ≤50 custom keys per subscriber.
- **SDK sync:** local cache + batch flush (not per-set POST, not manual-only).
- **Server storage:** per-key metadata `{value, updatedAt, source}`, stored as a
  **single nested column** (`attributes = {key: {value, updatedAt, source}}`) —
  single source of truth (Approach B). All existing consumers are updated.

## 1. Data model (Postgres)

`subscribers.attributes` jsonb changes from flat `{key: value}` to nested:

```jsonc
{
  "$email":       { "value": "a@b.com", "updatedAt": "2026-06-15T10:00:00.000Z", "source": "sdk" },
  "favoriteTeam": { "value": "GS",      "updatedAt": "2026-06-15T10:00:00.000Z", "source": "sdk" }
}
```

- `source` ∈ `"sdk" | "server" | "dashboard" | "legacy"`.
- **Migration:** backfill existing flat rows to
  `{key: {value, updatedAt: <migration timestamp>, source: "legacy"}}`.
  Deletion (`null` value) removes the key entirely; we do not keep tombstones.
  **Known limitation:** because deletes leave no tombstone, an out-of-order
  flush carrying an older value for a just-deleted key can resurrect it (the
  last-write-wins compare in §5 has nothing to compare against). Acceptable for
  v1; revisit with soft-delete tombstones if it bites.
- **Public contract unchanged:** every outward-facing surface (SDK, `/me`,
  offerings, dashboard API) continues to return/accept flat `{key: value}`. The
  nested shape is internal storage only.

### Shared helpers (`packages/shared` or `packages/db`)

- `flattenAttributes(nested): AttributeMap` — `{key: value}` projection.
- `applyAttribute(nested, key, value, source, updatedAt?): nested` — per-key
  upsert/delete with last-write-wins on `updatedAt`.
- `mergeAttributeMutations(nested, mutations[]): nested` — batch apply.

### Types (`@rovenue/shared`)

- `AttributeMap = Record<string, string>` — public flat map.
- `SubscriberAttributesInternal = Record<string, { value: string; updatedAt: string; source: AttributeSource }>` — internal nested.
- `AttributeSource = "sdk" | "server" | "dashboard" | "legacy"`.

## 2. Affected consumers (cost of Approach B — all updated)

| Location | Change |
|----------|--------|
| `apps/api/src/services/flag-engine.ts:171` | flatten before audience match |
| `apps/api/src/services/experiment-engine.ts:196` | flatten before audience match |
| `apps/api/src/routes/v1/me.ts` (`/me`, `/me/attributes`) | flatten on read; nested merge on write |
| `apps/api/src/routes/v1/subscribers.ts` (`:appUserId/attributes`) | same |
| `apps/api/src/routes/v1/offerings.ts:167`, `/v1/config` route | pass flattened map |
| `packages/db/src/drizzle/repositories/subscribers.ts` (`upsertSubscriber`, `findSubscriberAttributes*`) | nested read/write; nested-aware merge |
| `apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx` | render value + optional `updatedAt`/`source` badge |
| `packages/db/seed.ts:293` | nested shape |
| `apps/api/src/...anonymize-subscriber.ts` | nested-aware clear |
| `apps/api/src/...subscriber-transfer.ts` | nested-aware preserve/transfer |
| `@rovenue/shared` types | add internal nested + public `AttributeMap` |

## 3. Reserved key catalog (`$` prefix, validated)

Single source of truth in `packages/shared`. Catalog entry = `{ key, validate }`.

- **Identity:** `$email` (email format), `$displayName` (≤500), `$phoneNumber` (loose E.164).
- **Push:** `$fcmTokens`, `$apnsTokens` (string token; SDK fills per platform).
- **Attribution:** `$mediaSource`, `$campaign`, `$adGroup`, `$keyword`, `$creative`, `$ad`.
- **Device/consent:** `$idfa`, `$idfv`, `$gpsAdId`, `$attConsentStatus`
  (enum: `notDetermined | restricted | denied | authorized`).

Rules:
- A `$`-prefixed key **not** in the catalog → rejected (`400 INVALID_ARGUMENT`).
- Reserved value must pass its catalog validator.

## 4. Custom key rules

- key: must not start with `$`; matches `^[A-Za-z0-9_.-]{1,40}$`.
- value: `string | null` (null = delete); ≤500 chars.
- ≤50 custom keys per subscriber (reserved keys do not count toward the limit).

## 5. API (both endpoints)

Request body unchanged: `{ attributes: { [key: string]: string | null } }`.

Behavior:
1. Zod + catalog validation (reserved + custom rules). On violation:
   `400 INVALID_ARGUMENT` naming the offending key and reason.
2. Read current nested → apply per key (`null` = delete; else
   `{value, updatedAt: now, source}`) → write.
3. Response flattened via `flattenAttributes` to `{key: value}`.

- `source` = `"sdk"` for `/me/*` and `:appUserId/*`; dashboard writes (future)
  use `"dashboard"`.
- **Conflict resolution:** the SDK may send a per-attribute `updatedAt` (the
  client time the attribute was set). The server writes only if incoming
  `updatedAt` > stored `updatedAt` (true per-key last-write-wins). To avoid
  expanding the body shape, `updatedAt` is accepted as optional per-key meta;
  if absent the server uses `now`.

### Body shape (with optional meta)

Accept both the simple form and the meta form:

```jsonc
// simple
{ "attributes": { "$email": "a@b.com", "favoriteTeam": null } }

// with client timestamps (SDK flush)
{ "attributes": { "$email": { "value": "a@b.com", "updatedAt": "..." } } }
```

The validator normalizes both into `{key -> {value, updatedAt?}}` before applying.

## 6. SDK surface (4 layers)

Rust core (`packages/core-rs/src/api.rs`); Swift/Kotlin/RN façades are thin wrappers.

```
setAttributes(map: {string: string?})       // batch, null = delete
setEmail(string?) / setDisplayName(string?) / setPhoneNumber(string?)
setPushToken(string?)                        // routes to $apnsTokens or $fcmTokens per platform
setAttributionData(...)                      // typed helper for $mediaSource/$campaign/...
collectDeviceIdentifiers()                   // opt-in $idfa/$idfv/$gpsAdId/$attConsentStatus
flushAttributes() -> u32                     // manual flush, returns count synced
```

- Reserved setters are type-safe; `setAttributes` takes a free-form map.
- Client-side validation (key regex, 500-char cap) fails fast before queueing;
  the server re-validates (defense in depth).

## 7. SDK sync mechanics (mirrors session-event pipeline)

Reference infra: `packages/core-rs/src/sessions/{buffer,dispatcher}.rs`,
`packages/core-rs/src/cache/store.rs` (SQLite, WAL).

- **Local queue:** new `attribute_mutations` table in the existing `CacheStore`
  SQLite db — `{key, value, source, updatedAt, dirty}`. Native uses SQLite (not
  MMKV).
- **On set:** write local + mark dirty; reads reflect immediately (offline-first).
- **Flush triggers:** (a) 30s scheduler tick (like `SessionDispatcher`),
  (b) app background, (c) after `identify()`, (d) before purchase,
  (e) manual `flushAttributes()`.
- **Flush:** if a subscriber id is present, batch dirty mutations to
  `POST /v1/me/attributes` (sending per-key `updatedAt`); on success clear dirty,
  on failure leave queued for retry.
- **logout:** dirty attribute queue is `clear()`-ed, like the session buffer.

## 8. Testing & observability

- **Unit:** catalog validators; `flattenAttributes` / `applyAttribute` /
  `mergeAttributeMutations`; nested merge + last-write-wins.
- **Integration (testcontainers PG):** migration backfill; endpoint per-key
  delete/update; reserved-key rejection; custom-key limit enforcement.
- **Rust:** `attribute_mutations` queue + flush + offline-resilience tests;
  logout clears queue; per-platform `setPushToken` routing.
- **Dashboard:** nested → value render with `updatedAt`/`source` badge.

## Out of scope (YAGNI, later)

- Publishing attributes to ClickHouse/analytics (stays audience-only for now).
- Writing attributes from the dashboard (display only; `source: "dashboard"`
  infrastructure is left ready).
- Automatic device-attribute collection beyond opt-in `collectDeviceIdentifiers`
  (no implicit `$appVersion` etc.).
