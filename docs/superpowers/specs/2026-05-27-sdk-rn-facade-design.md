# SDK M5 — React Native Façade Design

## Overview

React Native façade over the existing Swift M3 + Kotlin M4 façades, exposed to JS via a single Nitro HybridObject. The RN package is a **thin parity layer**: it does not call StoreKit or Play Billing; consumers drive billing themselves (via `expo-iap` / `react-native-iap`) and hand JWS / purchase tokens to `Rovenue.postAppleReceipt` / `postGoogleReceipt`. Public API is split into an **imperative surface** (Promise-returning functions mirroring M3/M4 signatures) and a **React hooks surface** backed by a TS cache mirror that updates from native `ChangeEvent`s.

This spec is the direct counterpart of the [Swift M3 façade](./2026-05-26-sdk-swift-facade-design.md) and [Kotlin M4 façade](./2026-05-27-sdk-kotlin-facade-design.md). It assumes both have shipped — RN does not regenerate UniFFI bindings or touch the Rust core.

## Goals

- Public TS API that feels native to RN developers: `await Rovenue.identify(...)` + `useEntitlement('pro')`.
- Single Nitro HybridObject covering all M3/M4 methods + change-event subscription.
- iOS impl reuses `Rovenue.shared` (Swift M3); Android impl reuses `Rovenue.shared` (Kotlin M4). No code duplication of dispatcher / observer-bridge logic.
- TS cache mirror so hooks render synchronously without Suspense or loading state.
- 13 typed error classes mirroring `RovenueException` variants (no JSON-error-code switches in user code).
- Distribution via npm under `@rovenue/sdk-rn`. iOS via `pod install`; Android via `react-native autolink`.
- New React Native architecture only (Fabric + TurboModules via Nitro). No legacy bridge path.

## Non-Goals

- **Native billing.** No StoreKit2 / BillingClient wiring. Same posture as M3/M4. Consumers obtain JWS / purchase tokens themselves.
- **Restore purchases.** Would require platform-specific receipt enumeration — out of scope. Consumers can iterate their own purchases and call `postAppleReceipt` / `postGoogleReceipt` per item.
- **Expo Go support.** Nitro requires a custom dev client; consumers using Expo must run `eas build` (managed) or a bare workflow. Documented in README.
- **Web target.** `react-native-web` cannot load the native module. M5 is iOS + Android only. A web SDK (browser fetch + IndexedDB cache) is a separate plan.
- **Background polling lifecycle helpers.** Same as M3/M4: consumers call `setForeground(true/false)` from their app-state listener; we do not auto-wire `AppState`.
- **Sample app.** Deferred to the M6 distribution plan.

## Architectural decisions

| Concern | Choice | Reason |
|---|---|---|
| Native bridge | Nitro HybridObject wrapping `Rovenue.shared` (Swift) / `Rovenue.shared` (Kotlin) | Reuses M3/M4 dispatcher + observer logic. No double-bridging of `suspend`/`Combine`. |
| API surface | Imperative (`await Rovenue.X(...)`) + hooks (`useX`) | Mirrors RevenueCat / Adapty. Both common in RN apps; one is not a superset of the other. |
| State sync | TS cache mirror (`ReactiveStore`) updated by native events | Sync hook reads (no Suspense / loading flicker for cache-first data). Mount-time warm-up populates the store via the imperative read methods. |
| Event delivery | Nitro callback (`addChangeListener(cb)`) — one callback per native instance, fans out in TS to all `ReactiveStore` subscribers | Nitro supports JS callbacks as first-class hybrid objects. Single bridge crossing per change event is cheap. |
| Errors | 13 typed error classes (`RovenueError` + 12 subclasses, parity with `RovenueException` variants) | Native impl rejects with `code`+`message`; JS bridge maps `code` → class. Avoids user-side `switch (err.code)` boilerplate. |
| Subscription primitive | React 18 `useSyncExternalStore` | Concurrent-render safe; idiomatic for external state. No `zustand` dependency — `ReactiveStore` is ~50 lines. |
| Distribution | Pure RN package (`@rovenue/sdk-rn`), no Expo config plugin (consumers handle linking) | M6 will add an Expo config plugin if needed; for M5 the autolink path suffices. |
| TS module format | ESM + CJS dual via `tsup` (or existing `tsc` if dual not needed initially) | Current package uses `tsc` only; M5 keeps `tsc` and ships `.d.ts` + a single CJS entry. Dual format is a packaging concern for M6. |

## Public API Surface

### `Rovenue` namespace (imperative)

```ts
// packages/sdk-rn/src/index.ts

import { ChangeEvent, Entitlement, ReceiptResult, User } from './types';

export namespace Rovenue {
  /** Initialise the SDK. Synchronous wrt JS — internally calls
   *  NitroModules.createHybridObject and a single native configure().
   *  Throws InvalidApiKeyError if apiKey is blank or baseUrl invalid.
   *  Calling twice replaces the prior instance (shuts down its scope).
   */
  function configure(opts: {
    apiKey: string;
    baseUrl: string;
    debug?: boolean;
  }): void;

  function getVersion(): string;

  // Identity
  function currentUser(): Promise<User>;
  function identify(knownUserId: string): Promise<void>;

  // Entitlements
  function entitlement(id: string): Promise<Entitlement | null>;
  function entitlementsAll(): Promise<Entitlement[]>;
  function refreshEntitlements(): Promise<void>;

  // Credits
  function creditBalance(): Promise<number>;
  function refreshCredits(): Promise<void>;
  function consumeCredits(amount: number, description?: string): Promise<number>;

  // Receipts
  function postAppleReceipt(jws: string, productId: string): Promise<ReceiptResult>;
  function postGoogleReceipt(receipt: string, productId: string): Promise<ReceiptResult>;

  // Lifecycle
  function setForeground(foreground: boolean): void;
  function shutdown(): void;

  // Low-level subscription (for non-React consumers; hooks wrap this)
  function addChangeListener(cb: (e: ChangeEvent) => void): () => void;
}
```

### Hooks

```ts
// packages/sdk-rn/src/hooks/index.ts

export function useCurrentUser(): User | null;
export function useEntitlement(id: string): Entitlement | null;
export function useEntitlements(): Entitlement[];
export function useCreditBalance(): number;
```

All hooks read synchronously from `ReactiveStore` via `useSyncExternalStore`. First mount fires a one-shot warm-up Promise (`currentUser()` / `entitlementsAll()` / `creditBalance()`) if the store slot is empty. Subsequent renders read the cache.

### Types

```ts
export type User = { anonId: string; knownUserId?: string | null };
export type Entitlement = {
  id: string;
  active: boolean;
  expiresAt: string | null;  // ISO-8601
  productId: string | null;
};
export type ReceiptResult = {
  ok: boolean;
  entitlementsRefreshed: boolean;
  creditsRefreshed: boolean;
};
export type ChangeEvent =
  | 'ENTITLEMENTS_CHANGED'
  | 'IDENTITY_CHANGED'
  | 'CREDIT_BALANCE_CHANGED';
```

### Error classes

```ts
export class RovenueError extends Error { readonly code: string; }
export class InvalidApiKeyError extends RovenueError {}
export class NotConfiguredError extends RovenueError {}
export class NetworkUnavailableError extends RovenueError {}
export class TimeoutError extends RovenueError {}
export class RateLimitedError extends RovenueError { readonly retryAfter: number | null; }
export class ServerError extends RovenueError { readonly httpStatus: number | null; }
export class StorageError extends RovenueError {}
export class UserNotFoundError extends RovenueError {}
export class InsufficientCreditsError extends RovenueError { readonly available: number; }
export class EntitlementInactiveError extends RovenueError {}
export class DuplicatePurchaseError extends RovenueError {}
export class ReceiptInvalidError extends RovenueError {}
export class InternalError extends RovenueError {}
```

## Internal Components

```
packages/sdk-rn/
├── nitro.json
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                        # public barrel
│   ├── specs/
│   │   └── RovenueNitroSpec.nitro.ts   # Nitrogen HybridObject interface
│   ├── core/
│   │   ├── native.ts                   # NitroModules.createHybridObject('RovenueNitroSpec')
│   │   └── eventBridge.ts              # native change events → store mutations
│   ├── store/
│   │   └── reactiveStore.ts            # Map+listeners, ~50 lines
│   ├── api/
│   │   ├── configure.ts
│   │   ├── identity.ts
│   │   ├── entitlements.ts
│   │   ├── credits.ts
│   │   ├── receipts.ts
│   │   └── lifecycle.ts
│   ├── hooks/
│   │   ├── useCurrentUser.ts
│   │   ├── useEntitlement.ts
│   │   ├── useEntitlements.ts
│   │   └── useCreditBalance.ts
│   ├── errors.ts                       # 13 typed classes + code → class mapper
│   ├── types.ts
│   └── version.ts                      # existing, unchanged
├── ios/
│   ├── RovenueSdkRn.podspec
│   └── HybridRovenueNitroSpec.swift    # forwards to Rovenue.shared
├── android/
│   ├── build.gradle.kts
│   └── src/main/java/dev/rovenue/sdkrn/HybridRovenueNitroSpec.kt
└── __tests__/
    ├── reactiveStore.test.ts
    ├── eventBridge.test.ts
    ├── errors.test.ts
    └── hooks.test.tsx
```

### `RovenueNitroSpec.nitro.ts`

Nitrogen-generated HybridObject interface. Method signatures mirror M3/M4 verbatim. Returns `Promise<T>` for any method that hits the Rust core (UniFFI calls are blocking; the native impl wraps in `withContext(Dispatchers.IO)` / `Task { ... }` and resolves the Nitro Promise on completion). Sync methods: `setForeground`, `shutdown`, `getVersion`.

```ts
import { HybridObject } from 'react-native-nitro-modules';

export interface RovenueNitroSpec extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  configure(apiKey: string, baseUrl: string, debug: boolean): void;
  getVersion(): string;
  currentUser(): Promise<UserDTO>;
  identify(knownUserId: string): Promise<void>;
  entitlement(id: string): Promise<EntitlementDTO | null>;
  entitlementsAll(): Promise<EntitlementDTO[]>;
  refreshEntitlements(): Promise<void>;
  creditBalance(): Promise<number>;
  refreshCredits(): Promise<void>;
  consumeCredits(amount: number, description: string | null): Promise<number>;
  postAppleReceipt(jws: string, productId: string): Promise<ReceiptResultDTO>;
  postGoogleReceipt(receipt: string, productId: string): Promise<ReceiptResultDTO>;
  setForeground(foreground: boolean): void;
  shutdown(): void;
  addChangeListener(cb: (event: string) => void): () => void;
}
```

DTO types (`UserDTO`, `EntitlementDTO`, `ReceiptResultDTO`) are plain object shapes the JS bridge can serialise. They have the same field names as the M3/M4 types. The `index.ts` public types are aliases of these DTOs for now (M5 has no need to diverge).

### `HybridRovenueNitroSpec.swift`

```swift
import RovenueSwift  // M3 package

final class HybridRovenueNitroSpec: HybridRovenueNitroSpecSpec {
    func configure(apiKey: String, baseUrl: String, debug: Bool) throws {
        try Rovenue.configure(apiKey: apiKey, baseUrl: baseUrl, debug: debug)
    }
    func currentUser() async throws -> UserDTO {
        let u = try await Rovenue.shared.currentUser()
        return UserDTO(anonId: u.anonId, knownUserId: u.knownUserId)
    }
    // ... all other methods forward identically
    func addChangeListener(cb: @escaping (String) -> Void) -> () -> Void {
        let task = Task {
            for await event in Rovenue.shared.changes {
                cb(event.rawValueScreamingSnake())
            }
        }
        return { task.cancel() }
    }
}
```

Swift `async throws` is bridged to Nitro Promises automatically by Nitrogen. Errors propagate via Nitro's typed error channel (we set a `code` field that JS uses to pick the right error class).

### `HybridRovenueNitroSpec.kt`

```kotlin
import dev.rovenue.sdk.Rovenue
import kotlinx.coroutines.flow.collect

class HybridRovenueNitroSpec : HybridRovenueNitroSpecSpec() {
    override fun configure(apiKey: String, baseUrl: String, debug: Boolean) {
        Rovenue.configure(apiKey, baseUrl, debug)
    }
    override suspend fun currentUser(): UserDTO {
        val u = Rovenue.shared.currentUser()
        return UserDTO(u.anonId, u.knownUserId)
    }
    // ... etc
    override fun addChangeListener(cb: (String) -> Unit): () -> Unit {
        val job = scope.launch {
            Rovenue.shared.changes.collect { cb(it.name) }
        }
        return { job.cancel() }
    }
}
```

`suspend fun` is bridged to Nitro Promises automatically. `RovenueException` subclasses carry their `code` field via Nitro's typed error mapping.

### `ReactiveStore`

```ts
// packages/sdk-rn/src/store/reactiveStore.ts

type Slot = 'user' | 'creditBalance' | `entitlement:${string}` | 'entitlementsAll';

class ReactiveStore {
  private values = new Map<Slot, unknown>();
  private listeners = new Set<() => void>();
  get<T>(slot: Slot): T | undefined { return this.values.get(slot) as T; }
  set<T>(slot: Slot, value: T): void {
    this.values.set(slot, value);
    this.listeners.forEach(l => l());
  }
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
  clear(): void { this.values.clear(); this.listeners.forEach(l => l()); }
}

export const store = new ReactiveStore();
```

~50 lines. No external dep. `useSyncExternalStore(store.subscribe, () => store.get(slot))` powers every hook.

### `eventBridge`

```ts
// packages/sdk-rn/src/core/eventBridge.ts

import { native } from './native';
import { store } from '../store/reactiveStore';

let unsubscribe: (() => void) | null = null;

export function startEventBridge(): void {
  if (unsubscribe) return;
  unsubscribe = native.addChangeListener(async (event) => {
    switch (event) {
      case 'IDENTITY_CHANGED':
        store.set('user', await native.currentUser());
        break;
      case 'ENTITLEMENTS_CHANGED':
        const all = await native.entitlementsAll();
        store.set('entitlementsAll', all);
        for (const ent of all) store.set(`entitlement:${ent.id}`, ent);
        break;
      case 'CREDIT_BALANCE_CHANGED':
        store.set('creditBalance', await native.creditBalance());
        break;
    }
  });
}

export function stopEventBridge(): void {
  unsubscribe?.();
  unsubscribe = null;
}
```

Started automatically by `configure()`. Stopped by `shutdown()`.

### Hooks

```ts
// packages/sdk-rn/src/hooks/useEntitlement.ts

import { useSyncExternalStore, useEffect } from 'react';
import { store } from '../store/reactiveStore';
import { native } from '../core/native';

export function useEntitlement(id: string): Entitlement | null {
  useEffect(() => {
    // Mount-time warm-up if cache empty
    if (store.get(`entitlement:${id}`) === undefined) {
      native.entitlement(id).then(e => store.set(`entitlement:${id}`, e ?? null));
    }
  }, [id]);
  return useSyncExternalStore(
    store.subscribe,
    () => (store.get<Entitlement | null>(`entitlement:${id}`) ?? null),
  );
}
```

All four hooks follow this exact shape (different slot + different warm-up call).

## Data Flow

### Configure / cold start

1. App calls `Rovenue.configure({ apiKey, baseUrl })`.
2. `configure.ts` validates inputs (throws `InvalidApiKeyError` on blank apiKey, etc.).
3. `NitroModules.createHybridObject('RovenueNitroSpec')` is called once and cached.
4. `native.configure(apiKey, baseUrl, debug)` is invoked synchronously — native side runs `Rovenue.configure(...)` (M3 / M4 façade).
5. `startEventBridge()` registers a single `addChangeListener` callback against the native instance.
6. Return — no Promise. Hooks that mount immediately after will warm up their own slots.

### Imperative call (e.g. `Rovenue.consumeCredits(5)`)

1. JS calls `native.consumeCredits(5, null)` → Nitro Promise.
2. Native impl (Swift/Kotlin) calls `Rovenue.shared.consumeCredits(5, null)` — M3/M4 façade. This goes through `Dispatcher` → `withContext(Dispatchers.IO)` / `Task { }` → Rust core → HTTP.
3. Rust core success: returns new balance + emits `ChangeEvent.CREDIT_BALANCE_CHANGED` on the observer.
4. Native impl returns the balance through Nitro; JS Promise resolves with `5`-decremented value.
5. Asynchronously: native observer callback fires → JS `eventBridge` handler runs → store is mutated → React re-renders any `useCreditBalance()` consumers with the same value.

Result: imperative caller sees the new balance immediately as the Promise result; hooks see it ~one tick later via the event bridge. Both paths return the same value; the only divergence is timing.

### Hook re-render (e.g. background server-driven change)

1. Rust core polling tick discovers updated entitlements server-side.
2. Rust emits `ChangeEvent.ENTITLEMENTS_CHANGED`.
3. Native observer fires; Nitro callback delivers `'ENTITLEMENTS_CHANGED'` to JS.
4. `eventBridge` calls `native.entitlementsAll()`, mutates the store.
5. Every `useEntitlement(id)` and `useEntitlements()` consumer re-renders with the new value.

No JS-side polling. No manual refresh.

## Error Handling

Native impl throws `RovenueException` (Kotlin) or `Rovenue.Error` (Swift). Nitro's typed-error machinery passes the variant name as `code` plus the human message. JS bridge looks up the class:

```ts
// packages/sdk-rn/src/errors.ts

const ERROR_CLASSES: Record<string, new (msg: string, extras?: unknown) => RovenueError> = {
  InvalidApiKey: InvalidApiKeyError,
  NotConfigured: NotConfiguredError,
  // ... 13 total
};

export function mapNativeError(code: string, message: string, extras?: unknown): RovenueError {
  const Ctor = ERROR_CLASSES[code] ?? InternalError;
  return new Ctor(message, extras);
}
```

A wrapper around every `native.X(...)` Promise catches the Nitro error and re-throws via `mapNativeError`:

```ts
async function nativeCall<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) { throw mapNativeError(e.code, e.message, e.extras); }
}
```

`RateLimitedError.retryAfter` and `InsufficientCreditsError.available` are passed via Nitro's `extras` map (serialisable JSON). All other variants carry only `code` + `message`.

## Testing Strategy

**vitest** unit suites under `__tests__/`:

| Suite | Coverage |
|---|---|
| `reactiveStore.test.ts` | `get`/`set` mutate correctly; subscribers fire on `set`; unsubscribe stops notifications; no memory leak after many sub/unsub cycles |
| `eventBridge.test.ts` | Each `ChangeEvent` triggers the right `native.X()` refresh + store mutation; mock `native` module; verify slot keys |
| `errors.test.ts` | Each of 13 codes maps to the right class; unknown code → `InternalError`; `extras` fields preserved (`retryAfter`, `available`) |
| `hooks.test.tsx` | `useEntitlement('pro')` renders cached value; warm-up fires when slot empty; store mutation triggers re-render; unmount unsubscribes |
| `version.test.ts` (existing) | Cargo.toml-version parity — keep as-is |

**Mock NitroSpec:** a vitest module-mock that simulates the native interface with a mutable in-memory state. No real bridge — Nitro itself is end-to-end tested by Nitro maintainers; we test our integration logic only.

**Native impl tests:** out of scope for M5. Swift M3 and Kotlin M4 already have 30 and 16 tests respectively covering the façade. The Nitro layer is ~50 lines per platform — visual review + the sample-app smoke (M6) is sufficient.

**Parity script:** `scripts/sdk-parity.sh` already runs `pnpm --filter @rovenue/sdk-rn test`. After M5 the assertion will need updating from `"6 passed"` to the new count (M5 adds ~20–30 tests). Plan task handles this.

## Build & Distribution

- TS build: `tsc` to `dist/` (existing setup). Both `main` (CJS) and `types` (`.d.ts`) ship from `dist/`. ESM dual format is M6 work.
- iOS: `RovenueSdkRn.podspec` declares dep on the Swift M3 SPM package (via CocoaPods source override) or a pre-built XCFramework (M6 decides). For M5 dev we build M3 from source via `swift build` and link locally.
- Android: `build.gradle.kts` declares dep on `:sdk-kotlin` Gradle module. Both ship in the same monorepo so no Maven publish needed for M5.
- Nitrogen step: `pnpm --filter @rovenue/sdk-rn nitrogen` regenerates spec bindings; checked in for now (UniFFI-style).
- `package.json` `peerDependencies`: `react >=18`, `react-native >=0.73`, `react-native-nitro-modules >=0.20` (or whatever version the repo standardises on).

Versioning: `0.0.2` for M5 ship (current `0.0.1` is the M0 stub).

## Migration / Compatibility

The current `@rovenue/sdk-rn` is a TS stub (`configure(opts) → RovenueStub`). M5 replaces it. Consumers using the stub today:

- `configure({ apiKey, baseUrl })` → unchanged signature, now actually configures the native bridge.
- `RovenueStub.getVersion()` → removed; use `Rovenue.getVersion()` (namespace export).
- `getVersion()` named export → kept.

The stub's behaviour was non-functional (no network, no persistence). No real consumer can have depended on it. No deprecation period needed; we cut over directly.

## Open questions

- **Nitro version pinning:** the monorepo doesn't currently use Nitro. M5 introduces it via `react-native-nitro-modules` peer dep — we should decide the version range now to avoid future churn. Default to `>=0.20.0 <1.0.0` until Nitro 1.0 ships.
- **Logging:** Swift M3 / Kotlin M4 have no logger; debug events go via `Config.debug = true` and the Rust core's tracing layer. RN should expose a `Rovenue.setLogHandler(fn)` for JS-side log inspection — defer to M6, not blocking M5 ship.
- **Lifecycle helper for `setForeground`:** M3/M4 leave this to consumers. RN's `AppState` API makes auto-wiring trivial; we could ship `<RovenueProvider>` that listens to `AppState.change` and calls `setForeground(state === 'active')`. Decide during planning: include in M5 (small, useful) or defer.

## References

- [SDK overall design](./2026-05-08-sdk-design.md) — section 4.4 (RN façade)
- [Swift M3 façade design](./2026-05-26-sdk-swift-facade-design.md) — patterns we mirror
- [Kotlin M4 façade design](./2026-05-27-sdk-kotlin-facade-design.md) — direct parent of this spec
- [Nitro modules](https://nitro.margelo.com/) — bridge framework
- [Memory: nitro-fetch skill](memory://) — team uses Nitro elsewhere; consistent toolchain
