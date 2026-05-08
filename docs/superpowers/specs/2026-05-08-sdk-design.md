# Rovenue SDK — Design Spec

**Status:** Approved (brainstorming complete, awaiting user spec review before implementation plan)
**Date:** 2026-05-08
**Author:** brainstorming session, V. Furkan
**Scope:** V1 SDK across iOS (Swift), Android (Kotlin), and React Native (TypeScript), backed by a shared Rust core (`librovenue`)
**Supersedes:** any prior assumption that the SDK would live solely in `packages/sdk-rn` as TypeScript

---

## 1. Goals & Non-Goals

### 1.1 Goals

- Ship subscription, entitlement, and credit-ledger primitives across **three platforms in parallel** with **one source of truth for business logic** (Rust core via UniFFI bindings).
- Provide **idiomatic façades** per platform (Swift actor + AsyncStream, Kotlin suspend + Flow, TS hooks + imperative core).
- Offline-first: every read returns immediately from local cache; mutations queue and replay with idempotency-key safety.
- Anonymous-by-default identity with anon→known alias bridging that merges entitlements/credits server-side.
- Polling + ETag freshness model (no WebSocket dependency in V1).
- Single-file SQLite cache per app (encryptable via sqlcipher), survives cold starts.
- Receipt acquisition stays platform-native (StoreKit 2 / Play Billing 6); core handles transport + state.

### 1.2 Non-Goals (V1)

- Web/browser SDK (deferred to V1.3 — different billing primitive: Stripe Checkout, no StoreKit/BillingClient).
- Feature flags, experiments, audiences, leaderboards, anonymize/export — V1.1–V1.4.
- Paywall UI components (RevenueCat-style remote-configurable paywalls) — post-V1.
- Built-in metric exporters (Sentry, Datadog) — opt-in modules post-V1.
- WebSocket / SSE push freshness — re-evaluate after V1 polling experience.

---

## 2. Locked Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Cross-platform strategy | Rust core day-1 + idiomatic native façades | Single founder/small OSS team cannot maintain three separate full implementations; "extract to Rust later" doesn't happen in practice |
| V1 surface | subs + entitlements + credits across all 3 platforms | Money-earning core ships everywhere first; rest layers on |
| Native module tooling (RN) | Nitro Modules | JSI-based, codegen, sync calls; aligns with `react-native-nitro-fetch` already in ecosystem |
| Public API shape | Hooks-first + imperative core (per platform idiom) | Matches modern RN / SwiftUI / Compose expectations |
| Freshness model | Polling + ETag | Predictable, simple, offline-friendly; no fan-out infra needed |
| Identity model | Anonymous-by-default + alias on `identify()` | Pre-signup trial purchases supported; subscription transfer across devices works |
| Packaging (per platform) | Single package + subpath/module exports | Tree-shakeable, single version to track |
| Repo layout | Single monorepo (Cargo + Turborepo coexist) | Atomic cross-package PRs; CI sees breaking changes immediately |
| Rust async model | Sync FFI surface, async wrappers in façades | UniFFI async still constrained; matches Signal/1Password pattern |
| Cache backend | SQLite (`rusqlite` bundled, optional sqlcipher) | Portable across all platforms; FTS-ready; encrypted-at-rest option |
| Binding tool | UniFFI (Swift+Kotlin), Nitro+JNI/ObjC bridge (RN) | Mozilla-maintained, production-proven |
| Receipt acquisition | Native (StoreKit 2 / BillingClient); core handles post + state | Apple/Google forbid native billing access from non-platform languages |
| Distribution | SPM (binary XCFramework), Maven Central (.aar), npm (Nitro autolink) | Standard channels; binary distribution hides build complexity from users |
| Versioning | All façades + core lockstep on minor; FFI version embedded + checked at runtime | Drift impossible to ship accidentally |
| Error surface | Uniform `Result<T, RovenueError>` across all 3 façades | One mental model; throw/exception only for programmer error |

---

## 3. System Architecture

### 3.1 Three-Layer Hybrid

```
┌──────────────────────────────────────────────────────────────────┐
│  PLATFORM FAÇADES (idiomatic public API)                         │
│  ────────────────────────────────────────────────────────────    │
│  packages/sdk-swift/    Rovenue.swift                            │
│    • actor RovenueClient                                         │
│    • async func purchase(_:) → RovenueResult<PurchaseResult>     │
│    • AsyncStream<EntitlementUpdate> changes                      │
│                                                                   │
│  packages/sdk-kotlin/   dev.rovenue.sdk                          │
│    • class Rovenue (suspend fun purchase, Flow<Entitlement>)     │
│                                                                   │
│  packages/sdk-rn/       @rovenue/sdk-rn                          │
│    • imperative core (Rovenue.configure / .purchase)             │
│    • hooks (/billing, /entitlements, /credits subpaths)          │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                  UniFFI (Swift, Kotlin) | Nitro+JNI/ObjC (RN)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  RUST CORE — packages/core-rs/  (crate: librovenue)              │
│  ────────────────────────────────────────────────────────────    │
│    transport::http_client    (reqwest blocking + ETag, retry)    │
│    cache::store              (rusqlite, per-app-user partitioned)│
│    identity::manager         (anon→alias, persistence)           │
│    polling::scheduler        (foreground-aware, per-resource TTL)│
│    offline::queue            (purchase replay, exp backoff)      │
│    audit::hash_chain         (SHA-256 chain for SDK actions)     │
│    crypto::aes_gcm           (encrypted payload at rest)         │
│    error::RovenueError       (FFI-stable enum)                   │
│    api.rs                    (sync FFI surface, single facade)   │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  PLATFORM-NATIVE BILLING (zorunlu native)                        │
│  ────────────────────────────────────────────────────────────    │
│  iOS:     StoreKit2 (Swift)  → Transaction.updates AsyncSequence │
│  Android: BillingClient v6+ (Kotlin) → PurchasesUpdatedListener  │
│  RN:      Nitro modülü → iOS/Android native köprüleri            │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Architectural Principles

1. **Rust is stateful + IO**, native is OS-bridge only. No StoreKit/BillingClient calls from Rust.
2. **FFI is sync**, façade is async. Each façade wraps blocking calls in its native runtime (Swift `Task`, Kotlin `Dispatchers.IO`, JS background).
3. **Cache is one SQLite file per app**, namespaced per app-user; encryption optional (sqlcipher feature flag).
4. **Purchase, identity, entitlement state lives only in Rust**. Façades are stateless readers + native-event forwarders.

---

## 4. Component Breakdown

### 4.1 Rust Core (`packages/core-rs/`)

```
packages/core-rs/
├── Cargo.toml                    # workspace member
├── librovenue.udl                # UniFFI interface (Swift+Kotlin gen)
├── build.rs                      # uniffi-bindgen scaffolding
├── src/
│   ├── lib.rs
│   ├── api.rs                    # FFI surface (sync, single facade type)
│   ├── config.rs                 # Config { api_key, base_url, debug }
│   ├── transport/
│   │   ├── http_client.rs        # reqwest::blocking + ETag + retry
│   │   ├── etag_cache.rs         # SQLite-backed
│   │   └── idempotency.rs        # UUIDv7 keys per mutation
│   ├── cache/
│   │   ├── store.rs              # rusqlite Connection wrapper, migrations
│   │   ├── schema.sql            # entitlements, products, credits, etag_cache
│   │   └── ttl.rs                # per-resource TTL policy
│   ├── identity/
│   │   ├── manager.rs            # anon-id gen (cuid2), alias bridge
│   │   └── persistence.rs        # SQLite single-row "self" table
│   ├── polling/
│   │   └── scheduler.rs          # std::thread::spawn loop; foreground gate
│   ├── offline/
│   │   └── queue.rs              # pending mutations, exp backoff replay
│   ├── billing/
│   │   ├── receipt_post.rs       # POST /v1/receipts/apple, /google
│   │   └── types.rs
│   ├── credits/
│   │   ├── ledger.rs             # /v1/credits/balance, /consume
│   │   └── types.rs
│   ├── entitlements/
│   │   ├── reader.rs             # cache-first, polling-driven refresh
│   │   └── types.rs
│   ├── audit/
│   │   └── hash_chain.rs         # local SHA-256 chain for SDK actions
│   ├── crypto/
│   │   └── aes_gcm.rs            # ring or aes-gcm crate
│   ├── error.rs                  # #[derive(uniffi::Error)] enum
│   └── observer.rs               # Trait Observer { fn on_change(...) }
└── tests/
    ├── integration_*.rs          # mockito + testcontainers backed
    └── fixtures/
```

**FFI surface (sync, single object):**

```rust
pub struct RovenueCore { /* Mutex<inner> */ }

impl RovenueCore {
    pub fn new(config: Config) -> RovenueResult<Self>;
    pub fn identify(&self, app_user_id: String) -> RovenueResult<()>;
    pub fn current_user(&self) -> User;

    pub fn entitlement(&self, id: String) -> Option<Entitlement>;
    pub fn entitlements_all(&self) -> Vec<Entitlement>;
    pub fn refresh_entitlements(&self) -> RovenueResult<()>;

    pub fn credit_balance(&self) -> RovenueResult<i64>;
    pub fn consume_credits(&self, amount: u32, reason: String) -> RovenueResult<i64>;

    pub fn post_apple_receipt(&self, jws: String) -> RovenueResult<PurchaseResult>;
    pub fn post_google_receipt(&self, token: String, sku: String) -> RovenueResult<PurchaseResult>;

    pub fn register_observer(&self, obs: Arc<dyn Observer>);
    pub fn set_foreground(&self, foreground: bool);
    pub fn shutdown(&self);
}
```

### 4.2 Swift Façade (`packages/sdk-swift/`)

```
sdk-swift/
├── Package.swift                  # SPM, binaryTarget(XCFramework)
├── Sources/Rovenue/
│   ├── Rovenue.swift              # public actor + init
│   ├── Billing/
│   │   ├── StoreKit2Listener.swift
│   │   └── PurchaseFlow.swift     # Product.purchase() → JWS → core
│   ├── Entitlements/
│   │   └── EntitlementStore.swift # AsyncStream<[Entitlement]>
│   ├── Credits/
│   │   └── Credits.swift
│   ├── Hooks/                     # SwiftUI helpers
│   │   ├── EntitlementView.swift
│   │   └── CreditsView.swift
│   └── Internal/
│       ├── CoreObserverBridge.swift
│       └── BackgroundQueue.swift  # sync FFI → Task wrapping
└── Tests/RovenueTests/
```

### 4.3 Kotlin Façade (`packages/sdk-kotlin/`)

```
sdk-kotlin/
├── build.gradle.kts               # AAR + native .so'lar
├── src/main/kotlin/dev/rovenue/sdk/
│   ├── Rovenue.kt                 # public class, suspend funcs + Flow
│   ├── billing/
│   │   ├── BillingClientWrapper.kt
│   │   └── PurchaseFlow.kt
│   ├── entitlements/
│   │   └── EntitlementsRepository.kt   # Flow<List<Entitlement>>
│   ├── credits/
│   │   └── Credits.kt
│   ├── compose/                   # Jetpack Compose helpers
│   │   ├── rememberEntitlement.kt
│   │   └── rememberCredits.kt
│   └── internal/
│       ├── CoreObserverBridge.kt
│       └── DispatcherBackground.kt
└── src/test/
```

### 4.4 React Native Façade (`packages/sdk-rn/`)

```
sdk-rn/
├── package.json                   # subpath exports
├── nitro.json                     # Nitro modül konfig
├── ios/RovenueRN.podspec          # core-rs xcframework + StoreKit2 native
├── android/build.gradle           # core-rs .so + BillingClient v6+
├── src/
│   ├── index.ts                   # configure, identify, getCustomerInfo
│   ├── billing/
│   │   ├── index.ts               # purchase, restore
│   │   ├── nitro/                 # @rovenue/sdk-rn/billing → Nitro spec
│   │   └── hooks.ts               # useOfferings, usePurchase
│   ├── entitlements/
│   │   ├── index.ts
│   │   └── hooks.ts               # useEntitlement(id)
│   ├── credits/
│   │   └── hooks.ts               # useCredits, useConsume
│   ├── core/
│   │   ├── nitro-core.ts          # Nitro spec → librovenue
│   │   ├── observer.ts            # core → JS event bus
│   │   └── provider.tsx           # <RovenueProvider>
│   └── _internal/
│       ├── reactive-store.ts      # subscribable cache mirror
│       └── identity.ts
└── nitrogen/                      # generated bindings
```

### 4.5 Cross-Cutting Components

| Component | Lives in | Responsibility |
|---|---|---|
| HttpClient | Rust core | reqwest blocking, retry w/ jitter, ETag/If-None-Match, idempotency-key, auth header |
| CacheStore | Rust core | SQLite, schema migrations, per-resource TTL, ETag store, encrypted blobs |
| IdentityManager | Rust core | anon-id gen (cuid2), alias REST call, persistence, on-change emit |
| PollingScheduler | Rust core | foreground gate (façade tells core), per-resource interval, jitter |
| OfflineQueue | Rust core | failed mutations → SQLite queue, replay on reconnect with original idempotency-key |
| Observer bus | Rust core → façades | core push notification when state changes; façades convert to native streams |
| BillingNative | Per-platform façade | StoreKit2 / BillingClient wrappers; receipt → core.post_*_receipt |

---

## 5. Data Flows

### 5.1 Configure / Cold Start

```
App launch
  │
  ▼
Façade: Rovenue.configure({ apiKey, baseUrl })
  │
  ▼
RovenueCore::new(config)
  ├─ open SQLite (~/Library/.../rovenue.db | filesDir/rovenue.db)
  ├─ run migrations
  ├─ load IdentityManager from cache
  │     ├─ has anon_id? → use it
  │     └─ no? → generate cuid2, persist
  ├─ load cached entitlements + credit_balance from SQLite (instant return)
  ├─ start PollingScheduler (foreground=false initially)
  ├─ register OfflineQueue replay loop
  └─ return RovenueCore handle
  │
  ▼
Façade emits initial state from cache (no await)
  ▼
Façade calls core.set_foreground(true) when app foreground
  ▼
PollingScheduler kicks off:
  ├─ GET /v1/me/entitlements (If-None-Match: <etag>)
  ├─ GET /v1/me/credits/balance
  └─ on 200: update SQLite + Observer.on_change()
                                    │
                                    ▼
                       Façade re-emits via AsyncStream/Flow/hook
```

**Guarantee:** the façade's `getCustomerInfo()`-style first call **never awaits the network** — SQLite cache returns instantly, fresh data arrives via observer.

### 5.2 Purchase Flow (iOS shown; Android symmetric)

```
User taps "Subscribe"
  │
  ▼
Façade: rovenue.purchase(productId)
  │
  ▼
StoreKit2Listener.purchase(productId):
  ├─ Product.products(for: [id]) → product
  ├─ product.purchase(options: .appAccountToken(coreUserUUID))
  ├─ result = .success(VerificationResult.verified(transaction))
  ├─ jws = transaction.jsonRepresentation
  └─ transaction.finish() ✗ DEFER until backend confirms
  │
  ▼
core.post_apple_receipt(jws)
  ├─ HttpClient.post("/v1/receipts/apple", { jws, app_account_token })
  │     ├─ Idempotency-Key: sha256(jws)
  │     ├─ Authorization: Bearer <publicApiKey>
  │     └─ X-Rovenue-User: <coreUserId>
  ├─ Server: JWS chain-verify (Apple Root CA G3) → record purchase →
  │          update subscriber_access → respond { entitlements, credits }
  ├─ on success:
  │     ├─ CacheStore.upsert(entitlements)
  │     ├─ Observer.on_change(EntitlementsChanged)
  │     └─ return PurchaseResult { entitlements, transactionId }
  └─ on network failure:
        ├─ OfflineQueue.enqueue({ kind: 'apple_receipt', jws, attempts: 0 })
        ├─ return PurchaseResult { pending: true, ... }
        └─ replay loop retries with exp backoff (1s,2s,4s...max 5min)
  │
  ▼
Façade ack to UI
  ▼
Swift: transaction.finish()              ← only after core confirms
        StoreKit AsyncSequence Transaction.updates picks up next event
```

### 5.3 Entitlement Read (hot path)

```
UI render: useEntitlement("pro")
  │
  ▼
Hook subscribes to ReactiveStore (RN) / EntitlementStore (Swift) / Flow (Kotlin)
  │
  ▼
Façade calls core.entitlement("pro")
  ├─ Rust: SELECT FROM entitlements WHERE id='pro' AND user=current_user
  └─ returns Some(Entitlement{...}) | None  (microseconds)
  │
  ▼
UI render
  │
  ▼ (background)
PollingScheduler interval fires:
  ├─ GET /v1/me/entitlements (If-None-Match: <last_etag>)
  ├─ 304 → no-op
  └─ 200 → SQLite update → Observer.on_change → Hook re-renders
```

### 5.4 Identify / Alias

```
App calls rovenue.identify("user_42")
  │
  ▼
core.identify("user_42")
  ├─ current state: anon_id = "anon_abc123"
  ├─ POST /v1/identity/alias { from: anon_abc123, to: user_42 }
  ├─ Server: subscriber merge (entitlements + credits ledger), transactional
  ├─ response: { canonicalUserId: "user_42", entitlements, credits }
  ├─ IdentityManager: persist app_user_id="user_42", keep anon as link history
  ├─ CacheStore.replace_user_scope(known_id)
  └─ Observer.on_change(IdentityChanged + EntitlementsChanged)
```

Idempotent: same `to` twice → server returns same canonical, client unchanged.

### 5.5 Credit Consume (optimistic)

```
useConsume("watch_ad_reward", 5)
  │
  ▼
core.consume_credits(5, "watch_ad_reward")
  ├─ Optimistic: SQLite credit_balance -= 5; Observer.on_change()
  ├─ POST /v1/credits/consume { amount: 5, reason, idempotency_key: <uuidv7> }
  ├─ on 200 { new_balance }: SQLite write balance=server.new_balance
  ├─ on 409 (insufficient/race): rollback to server balance, return Err
  └─ on network fail: enqueue OfflineQueue (replayable, idempotent)
```

### 5.6 Offline Queue Replay

```
Connectivity restored (NWPathMonitor / ConnectivityManager → core via FFI)
  │
  ▼
OfflineQueue.replay():
  for each pending op (FIFO):
    ├─ retry with original Idempotency-Key
    ├─ on 2xx → dequeue, apply state
    ├─ on 4xx (non-retryable) → dequeue, log error to Observer
    └─ on 5xx/network → exp backoff, leave in queue
```

### 5.7 Polling Lifecycle

```
Foreground → core.set_foreground(true)
  └─ Scheduler enables timers:
        entitlements: 30s
        credits:      60s
Background → core.set_foreground(false)
  └─ Scheduler pauses; resumes on next foreground
```

---

## 6. Error Handling

### 6.1 FFI-Stable Error Enum

```rust
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum RovenueError {
    #[error("not configured")]                      NotConfigured,
    #[error("invalid api key")]                     InvalidApiKey,
    #[error("network unavailable")]                 NetworkUnavailable,
    #[error("timeout after {seconds}s")]            Timeout { seconds: u32 },
    #[error("server error: {status}")]              ServerError { status: u16, message: String },
    #[error("rate limited")]                        RateLimited { retry_after_ms: u64 },
    #[error("user not found")]                      UserNotFound,
    #[error("entitlement inactive: {id}")]          EntitlementInactive { id: String },
    #[error("insufficient credits")]                InsufficientCredits { balance: i64, requested: u32 },
    #[error("purchase already processed")]          DuplicatePurchase,
    #[error("receipt invalid: {reason}")]           ReceiptInvalid { reason: String },
    #[error("local storage error")]                 Storage(String),
    #[error("crypto error")]                        Crypto,
    #[error("internal: {0}")]                       Internal(String),
}
```

### 6.2 Uniform Result Type

```rust
#[derive(uniffi::Enum)]
pub enum RovenueResult<T> {
    Ok  { value: T },
    Err { error: RovenueError },
}
```

| Platform | Type | Usage |
|---|---|---|
| Swift | `enum RovenueResult<Success>` | `switch await rovenue.purchase(id) { case .ok(let r):; case .err(let e): }` |
| Kotlin | `sealed class RovenueResult<out T>` | `when (val r = rovenue.purchase(id)) { is Ok -> ; is Err -> }` |
| TS/RN | `{ ok: true; value: T } \| { ok: false; error: RovenueError }` | `if (r.ok) ... else ...` |

Throw/exception used only for **programmer error** (`NotConfigured`, `InvalidApiKey` at config time).

Reactive helpers (`useEntitlement`, `EntitlementView`, `rememberEntitlement`) wrap `RovenueResult` and expose `{ data, error, isLoading, isStale }` — uniform contract preserved.

### 6.3 Retry Policy

| Cause | Retryable? | Backoff | Queue offline? |
|---|---|---|---|
| Network down | ✓ | exp 1s→2s→4s→…cap 5min, jitter ±20% | ✓ for mutations |
| Timeout (>10s) | ✓ | same | ✓ |
| 5xx | ✓ | same | ✓ |
| 429 rate-limited | ✓ | honor `Retry-After` | ✗ memory-only |
| 401 invalid key | ✗ | — | ✗ fail-fast |
| 403, 404, 422 | ✗ | — | ✗ |
| 409 duplicate | — | treat as success | ✗ |
| Cert pin failure | ✗ | — | ✗ fail-fast |

Max attempts: mutations 50 (~7 days queue lifetime); reads 3 (then cache fallback).

### 6.4 Idempotency Keys

| Operation | Key formula |
|---|---|
| `post_apple_receipt` | `sha256(jws)` |
| `post_google_receipt` | `sha256(token + sku)` |
| `consume_credits` | client UUIDv7, persisted in queue row |
| `identify` | `sha256(from + to)` |

### 6.5 Subscription State Machine (client mirror)

Server SM (`TRIAL → ACTIVE → GRACE_PERIOD → EXPIRED|PAUSED|REFUNDED`) is read-only on the client. Client never triggers transitions, only projects server snapshots.

```
isActive = status ∈ {TRIAL, ACTIVE, GRACE_PERIOD} AND expiresAt > now() (±30s skew tolerance)
```

### 6.6 Failure-Mode Guarantees

| Scenario | Behavior |
|---|---|
| Backend fully down | Read from cache, mutations queued, UI not degraded |
| Cache corruption | Drop & reinit DB; anon_id preserved (Keychain/EncryptedSharedPrefs separate store) |
| Apple Root CA rotation | Server fail-closed (CLAUDE.md); client fail-soft → serve cached entitlement + log |
| Clock skew >1h | Server timestamps absolute; client tracks server-time delta on each successful response |
| StoreKit transaction unverified | `RovenueError::ReceiptInvalid` returned to façade |
| Concurrent purchases | StoreKit dedup + server idempotency-key — duplicates impossible |

### 6.7 Observability Hook

```rust
pub trait RovenueLogger: Send + Sync {
    fn log(&self, level: LogLevel, target: &str, msg: &str, fields: HashMap<String, String>);
}
```

Bridges:
- iOS: `os.Logger`
- Android: `android.util.Log` / Timber
- RN: `console.*` or user-injected

Built-in metric exporters: post-V1.

---

## 7. Testing Strategy

### 7.1 Test Pyramid

| Layer | Tooling | Target |
|---|---|---|
| Rust core unit | `cargo test` + `mockito` + in-memory `rusqlite` | 85%+ line coverage; all error paths |
| Rust core integration | `tests/integration_*.rs` + testcontainers `rovenue-api` | Real backend round-trip per endpoint |
| FFI contract | UniFFI generated test harness | Each FFI function smoke-called from Swift+Kotlin |
| Swift façade unit | XCTest + dependency-injected mock core | StoreKit2 wrapper, AsyncStream emit, error mapping |
| Swift e2e | XCTest + `.storekit` Configuration File | Full purchase, restore, refund, family sharing |
| Kotlin façade unit | JUnit 5 + Robolectric + mock core | BillingClient wrapper, Flow emit |
| Kotlin e2e | Android Instrumented Tests + Play Billing Library Test | Subscription, consumption, acknowledge |
| RN unit | Vitest + mock Nitro module | hooks render, observer→store, identity |
| RN e2e | Detox + StoreKit Configuration | iOS+Android purchase smoke |
| Cross-FFI parity | Single runner driving all 3 façades against fake backend | "Purchase X then check entitlement Y" yields identical result on all 3 |

### 7.2 Coverage Gates (V1)

| Component | Min line | Min branch |
|---|---|---|
| Rust core | 85% | 75% |
| Façade business logic | 80% | 70% |
| Native billing wrappers | smoke + manual | manual sign-off |
| Hook ergonomics | render-test + snapshot | — |

Mutation testing (`cargo-mutants`) nightly; threshold gating in V1.1.

### 7.3 Shared Fixtures

- `packages/core-rs/tests/fixtures/` — JWS receipts (Apple sandbox + production samples), Google purchase tokens, server response bodies
- `packages/sdk-rn/__mocks__/` — Nitro core mock; deterministic clocks for polling tests
- Shared **OpenAPI spec** → typed test fixtures generation (eliminates client/server schema drift)

---

## 8. Build & Distribution

### 8.1 Repo Layout (final)

```
rovenue/
├── apps/                        # api, dashboard, docs (existing)
├── packages/
│   ├── core-rs/                 # Cargo crate librovenue
│   ├── sdk-swift/               # SPM, depends on built XCFramework
│   ├── sdk-kotlin/              # Gradle, AAR + .so
│   ├── sdk-rn/                  # npm, Nitro modülü
│   ├── db/                      # existing
│   └── shared/                  # existing
├── Cargo.toml                   # workspace root (resolver = "2")
├── pnpm-workspace.yaml
├── turbo.json                   # cargo görevleri external task olarak
└── .github/workflows/sdk.yml
```

### 8.2 Naming & Namespacing

- **Rust crate:** `librovenue` (`crate-type = ["staticlib", "cdylib"]`)
- **Swift module:** `Rovenue`
- **Kotlin package:** `dev.rovenue.sdk`
- **npm package:** `@rovenue/sdk-rn`
- **C symbol prefix:** `rovenue_*`

### 8.3 Distribution Channels

| Platform | Channel | Tag pattern |
|---|---|---|
| Swift | SPM + GitHub Release XCFramework binary | `swift-v0.1.0` |
| Kotlin | Maven Central (`dev.rovenue:sdk:0.1.0`) via gradle-maven-publish-plugin | `kotlin-v0.1.0` |
| RN | npm `@rovenue/sdk-rn@0.1.0` (Nitro autolink iOS+Android) | `rn-v0.1.0` |
| Rust core | crates.io `librovenue@0.1.0` | `core-v0.1.0` |

**Coupling rule:** Façade `0.X.Y` works with core `0.X.*` (minor lockstep, patch slack). UniFFI checksum embedded; runtime check at SDK init: `core.ffi_version() == façade.expected_ffi_version()` else `RovenueError::Internal("ffi version mismatch")` fail-fast.

### 8.4 Cross-Compile Recipe (`packages/core-rs/scripts/build-all.sh`)

```sh
# iOS
cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim
cargo build --release --target x86_64-apple-ios
lipo -create ... -output librovenue-ios-sim.a
xcodebuild -create-xcframework \
    -library target/aarch64-apple-ios/release/librovenue.a \
    -library target/lipo/librovenue-ios-sim.a \
    -output dist/Rovenue.xcframework

# Android
cargo build --release --target aarch64-linux-android
cargo build --release --target armv7-linux-androideabi
cargo build --release --target x86_64-linux-android
# pack into AAR jniLibs/

# Bindings
uniffi-bindgen generate librovenue.udl --language swift  --out-dir packages/sdk-swift/Sources/Rovenue/Generated
uniffi-bindgen generate librovenue.udl --language kotlin --out-dir packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated
```

### 8.5 CI Matrix (`.github/workflows/sdk.yml`)

```
job: rust-core
  os: [ubuntu, macos, windows]
  steps: cargo fmt, clippy --deny warnings, test, doc

job: cross-compile
  needs: rust-core
  matrix:
    target: [aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-apple-ios,
             aarch64-linux-android, armv7-linux-androideabi, x86_64-linux-android,
             aarch64-apple-darwin, x86_64-apple-darwin]

job: build-xcframework
  needs: cross-compile (apple targets)
  runs-on: macos
  artifact: Rovenue.xcframework

job: build-aar
  needs: cross-compile (android targets)
  runs-on: ubuntu
  artifact: rovenue-sdk-${version}.aar

job: build-rn
  needs: [build-xcframework, build-aar]

job: parity-tests
  needs: [build-xcframework, build-aar, build-rn]
  services: rovenue-api (docker compose)

job: release  (on tag)
  needs: parity-tests
  publish:
    - SPM XCFramework binary release (GitHub Releases)
    - Maven Central via gradle publish
    - npm publish @rovenue/sdk-rn
```

---

## 9. V1 Milestones

| Milestone | Duration | Output |
|---|---|---|
| **M0 — Repo skeleton** | 1 week | Cargo workspace, UniFFI hello-world, CI matrix green; 3 platforms can `configure()` + `getVersion()` |
| **M1 — HttpClient + Cache + Identity** | 2 weeks | Anonymous identity, ETag fetch, SQLite cache, observer push; entitlement read flow complete |
| **M2 — Apple receipt round-trip** | 2 weeks | Swift StoreKit2 wrapper + core post → server verify; e2e "purchase → entitlement active" passing |
| **M3 — Android receipt round-trip** | 2 weeks | Kotlin BillingClient wrapper + symmetric flow |
| **M4 — RN parity** | 2 weeks | Nitro modülü, hooks, RN e2e |
| **M5 — Credits ledger** | 1 week | balance + consume, optimistic + queue |
| **M6 — Polishing** | 2 weeks | Offline queue replay, error surfaces, observability hooks, docs |
| **M7 — RC + beta** | 2 weeks | Pre-release; design partners dogfood |
| **V1.0 ship** | **~14 weeks (~3.5 months)** | npm/Maven/SPM published |

### Post-V1

| Version | Duration | Output |
|---|---|---|
| V1.1 | +4 weeks | Feature flags + experiments (3 platforms parallel) |
| V1.2 | +4 weeks | Audiences + leaderboards |
| V1.3 | +3 weeks | Web SDK (WASM + Stripe) |
| V1.4 | +4 weeks | Anonymize/export, GDPR/KVKK |

---

## 10. Open Questions / To Validate During Implementation

1. **UniFFI async maturity** — confirm sync-only FFI surface holds through implementation; if a core operation truly cannot run sync (e.g. long-running cache migration), revisit.
2. **rusqlite + sqlcipher cross-compile** — verify build works on all 6 mobile targets without ICE; fallback is plain SQLite + AES-GCM at app layer.
3. **Nitro + Rust dylib coexistence** — confirm Nitro module on iOS/Android can statically link `librovenue` alongside StoreKit2/BillingClient bindings without symbol conflict.
4. **Apple `appAccountToken` UUID format** — must be UUID; map our cuid2 user ID to a stable UUIDv8 derivation.
5. **Maven Central publishing for Rust-built .so artifacts** — verify gradle-maven-publish-plugin + signing works for binary AAR with embedded native libs.
6. **Android 14 background-restriction impact on PollingScheduler** — `set_foreground(false)` may need to halt timers entirely; check WorkManager fallback for occasional refreshes.
7. **Generic `RovenueResult<T>` across UniFFI** — UniFFI does not uniformly support generic enums across all language bindings. Implementation-time decision: either (a) generate concrete `EntitlementResult`, `CreditResult`, `PurchaseResult` etc. via macro, or (b) flatten to `(value: Option<T>, error: Option<RovenueError>)` tuples per operation. Either preserves the §6.2 user-facing contract.

---

## 11. Out of Scope (explicit)

- Web SDK (V1.3)
- Feature flags / experiments / audiences / leaderboards (V1.1, V1.2)
- WebSocket push freshness (re-evaluate post-V1)
- Built-in Sentry/Datadog metric exporters (opt-in modules post-V1)
- Paywall UI components (post-V1)
- Flutter, .NET, Unity SDKs (later — Rust core makes them ~2-week additions)
- StoreKit Original API (StoreKit 1) support — V1 is StoreKit 2 only

---

## 12. References

- `CLAUDE.md` — project tech stack and architecture decisions
- `docs/superpowers/specs/2026-04-20-tech-stack-upgrade/` — prior stack decisions
- Mozilla UniFFI: https://mozilla.github.io/uniffi-rs/
- Signal libsignal: https://github.com/signalapp/libsignal
- StoreKit 2: https://developer.apple.com/documentation/storekit
- Google Play Billing 6: https://developer.android.com/google/play/billing
- Nitro Modules: https://nitro.margelo.com/

---

*End of design spec.*
