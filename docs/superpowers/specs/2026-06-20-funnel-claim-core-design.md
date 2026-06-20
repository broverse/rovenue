# Sub-project A — Funnel Claim Core + Install Lifecycle (Design)

**Date:** 2026-06-20
**Status:** Approved design, pre-plan
**Parent:** [Funnel Attribution SDK Client decomposition map](./2026-06-20-funnel-attribution-sdk-decomposition.md)
**Scope:** Sub-project **A** only. Native data collection (Android Install
Referrer, iOS clipboard), deep-link wiring, auto first-launch orchestration,
and email/claim-code UI are sub-projects B–G and out of scope here.

## 1. Background

The onboarding-funnel backend is production-ready (3 claim endpoints, 8 tables,
services, outbox). The SDK client is greenfield — no scaffolding to reuse
(unlike `track()`). This sub-project builds the **claim client primitives** and
the **install lifecycle**: the Rust core methods + FFI + façades that POST to the
three claim endpoints, persist an `install_id`, track a once-per-install claim
state, hydrate entitlements, and deliver the resolved claim to the app via a
dedicated callback. The host app (or later sub-projects) supplies the inputs;
**A collects no native device data** — inputs are parameters.

The SDK is a Rust core crate (`packages/core-rs`, `librovenue`) with
Swift/Kotlin/RN façades generated via uniffi. See [[rovenue_sdk_architecture]].

## 2. Goals / Non-goals

**Goals**
- `Rovenue.claimFunnelToken`, `Rovenue.claimInstall`, `Rovenue.claimViaEmail`
  public methods across RN TS + Swift + Kotlin.
- `install_id` generated once and persisted; a once-per-install claim state
  machine (`pending`/`claimed`/`failed`) that later sub-project E reads.
- A dedicated payload-carrying callback (`onFunnelClaimResolved`) fired whenever
  a claim resolves, plus the methods returning their result directly.
- Entitlements granted by a claim are delivered by refreshing the existing
  entitlements cache after a successful claim (no backend change).

**Non-goals (this sub-project)**
- Native Install Referrer / clipboard collection (B/C).
- Deep-link/universal-link token capture (D).
- Automatic first-launch orchestration + timeout (E).
- Email UI / manual claim-code (F); App Store privacy manifest (G).
- The iOS IP-only matching backend change (C). `claimInstall` here is a faithful
  client of the **current** backend `claim-install` schema.

## 3. Backend contracts (authoritative)

Auth for all three: PUBLIC **or** SECRET API key (`apiKeyAuth("any")`). The SDK
uses its public Bearer token.

**`POST /v1/subscribers/claim-funnel-token`**
- Request: `{ token: string(40–64), anon_id: string(1–64) }`
- Success `200`: `{ data: { subscriber_id: string, entitlements: [], funnel_answers: Record<string, unknown> } }`
  — **`entitlements` is always empty**; the SDK does NOT hydrate from this
  response (see §5.4).
- Errors: `404` unknown token · `410` token expired · `409` already claimed by a
  different subscriber. (Idempotent reclaim by the same subscriber returns `200`
  with the same payload.)

**`POST /v1/sdk/claim-install`**
- Request: `{ platform: "ios"|"android", locale: string(2–16), timezone: string(1–64), screen_dims: string /^\d+x\d+$/, device_model?: string(≤64), install_referrer?: string(≤2048), install_id: string(1–128) }`
- Success `200`: `{ data: { token: string } }` — a recovered funnel token.
- `404`: `{ data: null }` — **no match (a normal outcome, not an error)**.

**`POST /v1/sdk/claim-via-email`**
- Request: `{ email: string(email, ≤254), install_id: string(1–128) }`
- Always `202`: `{ data: null }` (no email-enumeration leak). The claim
  completes later when the magic link returns to the app (deep link →
  `claimFunnelToken`, sub-project D).

## 4. Public API surface (RN TS)

```ts
Rovenue.claimFunnelToken(token: string): Promise<FunnelClaimResult>
Rovenue.claimInstall(params: ClaimInstallParams): Promise<FunnelClaimResult | null>
Rovenue.claimViaEmail(email: string): Promise<void>
Rovenue.addFunnelClaimListener(cb: (result: FunnelClaimResult) => void): () => void

interface FunnelClaimResult {
  subscriberId: string;
  funnelAnswers: Record<string, unknown>; // parsed from funnel_answers_json
}

interface ClaimInstallParams {
  platform: "ios" | "android";
  locale: string;          // e.g. "en-US"
  timezone: string;        // IANA, e.g. "Europe/Istanbul"
  screenDims: string;      // "WIDTHxHEIGHT", e.g. "390x844"
  deviceModel?: string;    // e.g. "iPhone15,2"
  installReferrer?: string;// raw Play Install Referrer (Android)
}
```

`install_id` is **core-managed** — it is NOT a parameter; the core fills it into
the `claim-install` / `claim-via-email` request bodies.

`claimInstall` performs the **full chain in one call**: POST `claim-install` →
on `200` take the recovered `token` and immediately call the internal
`claim_funnel_token(token)` path → returns the `FunnelClaimResult`; on `404`
(no match) returns `null`.

## 5. Rust core design (`packages/core-rs/src/`)

### 5.1 New module `funnel/`
- `funnel/mod.rs` — re-exports; the `FunnelClaimResult` and `ClaimInstallParams`
  types; the `FunnelClaimListener` trait.
- `funnel/client.rs` — `FunnelClient { http: Arc<HttpClient> }` with three POST
  methods mirroring §3 (request structs with serde `camelCase`/`snake_case` to
  match each endpoint's exact body keys — note the bodies use snake_case:
  `anon_id`, `screen_dims`, `install_referrer`, `install_id`). Returns typed
  outcomes; maps status codes to the error/option semantics in §6.

### 5.2 `install_id` + state — cache migration V9
Add `MIGRATION_V9` and bump `schema::LATEST` to `9`:
```sql
CREATE TABLE funnel_install (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    install_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE funnel_claim_state (
    install_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,            -- 'pending' | 'claimed' | 'failed'
    subscriber_id TEXT,
    claimed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
);
UPDATE schema_meta SET version = 9;
```
- `install_id` is generated lazily on first access as `inst_<cuid2>` and persisted
  in the single-row `funnel_install` table (mirrors the identity table pattern).
- `funnel_claim_state` records the outcome of a claim keyed by `install_id`;
  sub-project E reads it to avoid re-running resolution. In A, the claim methods
  write `claimed`(+subscriber_id) on success and `failed` on a terminal failure.

### 5.3 `api.rs` methods (`impl RovenueCore`)
- Hold `funnel: Arc<FunnelClient>` and a `FunnelClaimBus` (holds the registered
  listener), constructed from the shared `http`/`store`.
- `pub fn claim_funnel_token(&self, token: String) -> RovenueResult<FunnelClaimResult>`
  1. POST with `anon_id = self.identity.rovenue_id()`.
  2. Map `404→FunnelTokenNotFound`, `410→FunnelTokenExpired`,
     `409→FunnelTokenAlreadyClaimed`.
  3. On `200`: `self.refresh_entitlements()` (§5.4); write `funnel_claim_state`
     = claimed; build `FunnelClaimResult`; **fire the callback**; return it.
- `pub fn claim_install(&self, params: ClaimInstallParams) -> RovenueResult<Option<FunnelClaimResult>>`
  — POST `claim-install` with the core `install_id`; on `200{token}` chain into
  `claim_funnel_token(token)` and return `Some(result)`; on `404` return `None`.
- `pub fn claim_via_email(&self, email: String) -> RovenueResult<()>` — POST with
  the core `install_id`; `202` → `Ok(())`. (Resolution happens later via D.)
- `pub fn register_funnel_claim_listener(&self, l: Box<dyn FunnelClaimListener>)`
- `pub fn install_id(&self) -> String` — exposes the persisted id (used by B/C
  later; handy for debugging now).

### 5.4 Entitlements after claim (decision: refresh, no backend change)
The claim response carries empty entitlements, so on a successful
`claim_funnel_token` the core calls the existing
`self.refresh_entitlements()` (GET `/v1/me/entitlements`), which hydrates the
SQLite cache and emits `EntitlementsChanged` through the existing machinery. The
`FunnelClaimResult` itself carries only `subscriber_id` + `funnel_answers`; the
app reads entitlements through the normal entitlements API/hooks.

## 6. FFI / `.udl` + error handling

```
[Error] enum RovenueError {
    // …existing…
    "FunnelTokenNotFound",        // claim-funnel-token 404
    "FunnelTokenExpired",         // 410
    "FunnelTokenAlreadyClaimed",  // 409 (different subscriber)
};

dictionary FunnelClaimResult {
    string subscriber_id;
    string funnel_answers_json;   // UniFFI can't carry arbitrary JSON; façades parse
};

dictionary ClaimInstallParams {
    string platform;
    string locale;
    string timezone;
    string screen_dims;
    string? device_model;
    string? install_referrer;
};

callback interface FunnelClaimListener {
    void on_funnel_claim_resolved(FunnelClaimResult result);
};

interface RovenueCore {
    // …
    [Throws=RovenueError] FunnelClaimResult claim_funnel_token(string token);
    [Throws=RovenueError] FunnelClaimResult? claim_install(ClaimInstallParams params);
    [Throws=RovenueError] void claim_via_email(string email);
    void register_funnel_claim_listener(FunnelClaimListener listener);
    string install_id();
};
```

- `claim-install` `404` is **not** an error — it maps to `Ok(None)`. Only
  `claim_funnel_token`'s `404` is the `FunnelTokenNotFound` error.
- `funnel_answers_json` is the raw `funnel_answers` object serialized to a JSON
  string (mirrors the `remote_config_json` / `value_json` pattern).
- Bindings regenerated via `npm run sdk:bindings`; the tracked Kotlin binding
  `librovenue.kt` is committed, the Swift binding is gitignored (see
  [[rovenue_sdk_uniffi_bindings]]).

## 7. Façades

- Swift façade (`packages/sdk-swift/.../Rovenue.swift`) + Expo iOS module
  (`packages/sdk-rn/ios/RovenueModule.swift`): the 3 methods (via `dispatcher.run`
  + `mapError`) + `addFunnelClaimListener` bridging the uniffi callback to an
  Expo event.
- Kotlin façade (`packages/sdk-kotlin/.../Rovenue.kt`) + Expo Android module:
  same shape.
- RN TS (`packages/sdk-rn/src/api/funnel.ts`): `claimFunnelToken`,
  `claimInstall`, `claimViaEmail` through the existing `call()` error-mapping
  helper; `addFunnelClaimListener` over the existing Expo event emitter; parse
  `funnel_answers_json` → `funnelAnswers` and map snake↔camel at the TS boundary.
  Export the methods + types from `src/index.ts`. Add error subclasses for the
  three new `RovenueError` codes in `src/errors.ts` + `mapNativeError`.

## 8. Testing

- **Rust unit** (`funnel/client.rs` + `api.rs`, mockito): each endpoint's body +
  status mapping — `claim_funnel_token` happy path (200 → refresh chained →
  callback fired → state=claimed), `404/410/409` → the three error variants;
  `claim_install` 200 → chains to claim-funnel-token → `Some(result)`, 404 →
  `Ok(None)`; `claim_via_email` 202 → `Ok(())`; `install_id` persists across a
  reopen; `funnel_claim_state` written correctly.
- **Cache migration**: V9 applies cleanly; existing data preserved; `LATEST==9`.
- **RN TS** (Vitest): wrappers call native with mapped args; `funnel_answers_json`
  parsed to `funnelAnswers`; listener subscribe/unsubscribe; error-code mapping.
- **Façade build**: Kotlin `testDebugUnitTest` (see [[rovenue_sdk_kotlin_test_verify]]);
  Swift build.

## 9. Versioning

Additive, non-breaking: minor bump of the crate version (workspace `Cargo.toml`)
+ TS `SDK_VERSION` parity + RN npm package version. New `RovenueError` variants,
the `FunnelClaimListener` callback, and the new methods are additive to the FFI
surface.

## 10. Out-of-scope dependencies noted for later sub-projects

- The current backend `claim-install` requires `locale/timezone/screen_dims`.
  The iOS IP-only relaxation is **sub-project C** (backend tweak). In A,
  `claimInstall` faithfully sends those fields (callers supply them), so A is
  exercised primarily by the Android-referrer path + mocked tests.
- The `FunnelClaimListener` will also be fired by sub-project E's automatic
  first-launch orchestration; A only wires it for direct calls.
