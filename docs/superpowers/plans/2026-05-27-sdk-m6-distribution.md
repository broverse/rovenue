# SDK M6 — Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the M6 distribution milestone — pivot `@rovenue/sdk-rn` from Nitro Modules to Expo Modules, rename it to `@rovenue/react-native-sdk@0.1.0`, ship a config plugin that injects M3 SPM + M4 Gradle composite build into consumer apps, add a minimal smoke sample app under `examples/sample-rn-expo/`, ship TS dual format via tsup, and add `Rovenue.setLogHandler(fn)` on all three layers (M3 Swift, M4 Kotlin, RN JS).

**Architecture:** The M5 TS public surface (`Rovenue.X`, `useEntitlement`, errors, ReactiveStore, eventBridge) is binding-framework-agnostic — only the seam at `src/core/native.ts` + the vitest mock target change. Native bridges are rewritten as Expo Module DSL classes. A `plugin/` directory ships an Expo config plugin that patches the consumer's Podfile (adding `pod 'Rovenue', :path =>`) and `settings.gradle.kts`/`app/build.gradle` (adding `includeBuild` + `dev.rovenue:sdk:0.1.0` dep). The sample app inside the monorepo links via `workspace:*`, exercising the plugin end-to-end.

**Tech Stack:** TypeScript 5.4 + vitest 1.6 (existing), `expo-modules-core@^1.12` (NEW peer), `expo@~51.0` (NEW peer), `@expo/config-plugins@^8.0` (NEW dev/runtime), `tsup@^8.0` (NEW dev — dual format build), `react-native@0.74`, M3 Swift package (`packages/sdk-swift/`), M4 Kotlin Gradle module (`packages/sdk-kotlin/`), Rust core (`packages/core-rs/`, unchanged).

**Reality-check notes vs the spec (NOT deviations):**

1. **Task 1 is intentionally large.** The JS-side binding framework swap (Nitro → Expo) is one logically atomic unit: `_mockNative.ts` mock surface, `vitest.config.ts` alias, `core/native.ts` seam, `core/eventBridge.ts` event subscription pattern, `specs/*.ts` type definition, and `_stub*.ts` test shim all move together. Splitting would leave the test suite broken between subtasks.

2. **Plugin tests are deferred to Task 9 (sample app build).** The config plugin manipulates Podfile + settings.gradle text. Unit-testing those mods in vitest is possible but low-value — the actual validation is "does `expo prebuild` produce a working Podfile/gradle setup?" The sample app build in Task 11 is the integration test.

3. **`setLogHandler` JS test (Task 2) doesn't exercise the native side.** It tests that `Rovenue.setLogHandler(fn)` correctly subscribes/unsubscribes through the emitter. The actual native emit→JS flow is validated by Tasks 5 (M3 Swift LogHandlerTests) and 7 (M4 Kotlin LogHandlerTest).

4. **`packages/sdk-rn/` directory keeps its name.** Only the npm package name changes. The M5 plan archive at `docs/superpowers/plans/2026-05-27-sdk-m5-rn-facade.md` stays untouched.

5. **Net test count: 130 → 136.** RN 48→50 (+2 log), Swift 30→32 (+2 LogHandler), Kotlin 16→18 (+2 LogHandler), Rust unchanged at 36. Plus 2 best-effort native compile gates (iOS + Android sample).

---

## File Structure

**Deleted (M5 Nitro artifacts):**
- `packages/sdk-rn/nitro.json`
- `packages/sdk-rn/src/specs/RovenueNitroSpec.nitro.ts`
- `packages/sdk-rn/src/__tests__/_stubNitroModules.ts`
- `packages/sdk-rn/ios/RovenueSdkRn.podspec` (M5 Nitro version — recreated with Expo conventions in Task 3)
- `packages/sdk-rn/ios/HybridRovenueNitroSpec.swift`
- `packages/sdk-rn/android/build.gradle.kts` (M5 version — recreated as `build.gradle` in Task 4)
- `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/HybridRovenueNitroSpec.kt`

**Modified:**
- `packages/sdk-rn/package.json` — name, version, deps, exports, scripts (Task 1, 9)
- `packages/sdk-rn/tsconfig.json` — exclude additions (Task 9)
- `packages/sdk-rn/vitest.config.ts` — alias swap (Task 1)
- `packages/sdk-rn/src/core/native.ts` — Expo Modules API (Task 1)
- `packages/sdk-rn/src/core/eventBridge.ts` — emitter subscription (Task 1)
- `packages/sdk-rn/src/__tests__/_mockNative.ts` — type rename + log mock surface (Task 1)
- `packages/sdk-rn/src/index.ts` — Rovenue.setLogHandler + LogEntry re-export (Task 2)
- `pnpm-workspace.yaml` — `examples/*` glob (Task 10)
- `scripts/sdk-parity.sh` — RN filter rename + native build sections (Task 11)
- `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` — LogEntry + setLogHandler + emit calls (Task 5)
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` — LogEntry + setLogHandler + emit calls (Task 7)
- `packages/sdk-kotlin/build.gradle.kts` — group + version + publication (Task 7)

**New:**
- `packages/sdk-rn/expo-module.config.json` (Task 1)
- `packages/sdk-rn/app.plugin.js` (Task 8)
- `packages/sdk-rn/tsconfig.plugin.json` (Task 8)
- `packages/sdk-rn/tsup.config.ts` (Task 9)
- `packages/sdk-rn/src/specs/RovenueModule.types.ts` (Task 1)
- `packages/sdk-rn/src/__tests__/_stubExpoModules.ts` (Task 1)
- `packages/sdk-rn/src/api/log.ts` (Task 2)
- `packages/sdk-rn/src/__tests__/log.test.ts` (Task 2)
- `packages/sdk-rn/ios/RovenueSdkRn.podspec` (Task 3, Expo convention)
- `packages/sdk-rn/ios/RovenueModule.swift` (Task 3)
- `packages/sdk-rn/android/build.gradle` (Task 4, Expo convention)
- `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt` (Task 4)
- `packages/sdk-rn/plugin/index.ts` (Task 8)
- `packages/sdk-rn/plugin/withRovenueIos.ts` (Task 8)
- `packages/sdk-rn/plugin/withRovenueAndroid.ts` (Task 8)
- `packages/sdk-swift/Rovenue.podspec` (Task 6)
- `packages/sdk-swift/Tests/RovenueTests/LogHandlerTests.swift` (Task 5)
- `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/LogHandlerTest.kt` (Task 7)
- `examples/sample-rn-expo/package.json` (Task 10)
- `examples/sample-rn-expo/app.json` (Task 10)
- `examples/sample-rn-expo/tsconfig.json` (Task 10)
- `examples/sample-rn-expo/metro.config.js` (Task 10)
- `examples/sample-rn-expo/App.tsx` (Task 10)
- `examples/sample-rn-expo/README.md` (Task 10)

---

## Conventions

- **TDD per task** where tests exist (Tasks 2, 5, 7). Native source files (Tasks 3, 4, 6) are validated by syntax check + sample-app build (Task 11).
- **Run JS tests:** `cd packages/sdk-rn && pnpm test`
- **Run Swift tests:** from repo root, `cd packages/sdk-swift && DYLD_LIBRARY_PATH="$(pwd)/../../target/release" swift test`
- **Run Kotlin tests:** from repo root, `cd packages/sdk-kotlin && gradle test --no-daemon --console=plain` (if gradle on PATH)
- **Commit messages:** `feat(sdk-rn)|chore(sdk-rn)|test(sdk-rn)|feat(sdk-swift)|feat(sdk-kotlin)|test(sdk)` per existing conventions.
- **Working directory:** all paths are relative to the repo root or the active worktree at `/Volumes/Development/rovenue/.claude/worktrees/sdk-m6-distribution` (created by the executing skill).

---

## Task 1: JS-side binding framework swap (Nitro → Expo) + package rename

**Files:**
- Modify: `packages/sdk-rn/package.json`
- Create: `packages/sdk-rn/expo-module.config.json`
- Modify: `packages/sdk-rn/vitest.config.ts`
- Create: `packages/sdk-rn/src/__tests__/_stubExpoModules.ts`
- Delete: `packages/sdk-rn/src/__tests__/_stubNitroModules.ts`
- Create: `packages/sdk-rn/src/specs/RovenueModule.types.ts`
- Delete: `packages/sdk-rn/src/specs/RovenueNitroSpec.nitro.ts`
- Delete: `packages/sdk-rn/nitro.json`
- Modify: `packages/sdk-rn/src/__tests__/_mockNative.ts`
- Modify: `packages/sdk-rn/src/core/native.ts`
- Modify: `packages/sdk-rn/src/core/eventBridge.ts`
- Modify: `scripts/sdk-parity.sh` (filter rename only — native sections come in Task 11)

This task atomically swaps the JS-side native abstraction. All 48 existing tests must remain green at the end of this task.

- [ ] **Step 1.1: Rewrite `packages/sdk-rn/package.json`**

```json
{
  "name": "@rovenue/react-native-sdk",
  "version": "0.1.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./version": "./src/version.ts"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "peerDependencies": {
    "expo": ">=51.0.0 <53.0.0",
    "expo-modules-core": ">=1.12.0 <3.0.0",
    "react": ">=18",
    "react-native": ">=0.73"
  },
  "dependencies": {
    "@rovenue/shared": "workspace:*"
  },
  "devDependencies": {
    "@expo/config-plugins": "^8.0.0",
    "@testing-library/react": "^14.2.0",
    "@types/react": "^18.2.0",
    "expo-modules-core": "^1.12.0",
    "happy-dom": "^14.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "typescript": "^5.4.0",
    "vitest": "^1.3.0"
  }
}
```

NOTE: `expo-modules-core` is dual-listed (peer + devDep) so vitest can resolve the alias target type-only, while consumers bring it via peer.

- [ ] **Step 1.2: Create `packages/sdk-rn/expo-module.config.json`**

```json
{
  "platforms": ["ios", "android"],
  "ios": {
    "modules": ["RovenueModule"]
  },
  "android": {
    "modules": ["dev.rovenue.sdkrn.RovenueModule"]
  }
}
```

- [ ] **Step 1.3: Delete the Nitro spec + stub + nitro.json**

```bash
rm packages/sdk-rn/src/specs/RovenueNitroSpec.nitro.ts
rm packages/sdk-rn/src/__tests__/_stubNitroModules.ts
rm packages/sdk-rn/nitro.json
```

- [ ] **Step 1.4: Create `packages/sdk-rn/src/specs/RovenueModule.types.ts`**

```ts
// RovenueModule — TypeScript shape of the native Expo module. Mirrors
// the M3 Swift / M4 Kotlin public surfaces exactly. Used only for
// typechecking; the runtime instance is fetched via
// `requireNativeModule('Rovenue')`.

export type UserDTO = {
  anonId: string;
  knownUserId: string | null;
};

export type EntitlementDTO = {
  id: string;
  active: boolean;
  expiresAt: string | null;
  productId: string | null;
};

export type ReceiptResultDTO = {
  ok: boolean;
  entitlementsRefreshed: boolean;
  creditsRefreshed: boolean;
};

export type LogEntryDTO = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

export interface RovenueModuleSpec {
  // Lifecycle
  configure(apiKey: string, baseUrl: string, debug: boolean): void;
  shutdown(): void;
  setForeground(foreground: boolean): void;
  getVersion(): string;

  // Identity
  currentUser(): Promise<UserDTO>;
  identify(knownUserId: string): Promise<void>;

  // Entitlements
  entitlement(id: string): Promise<EntitlementDTO | null>;
  entitlementsAll(): Promise<EntitlementDTO[]>;
  refreshEntitlements(): Promise<void>;

  // Credits
  creditBalance(): Promise<number>;
  refreshCredits(): Promise<void>;
  consumeCredits(amount: number, description: string | null): Promise<number>;

  // Receipts
  postAppleReceipt(jws: string, productId: string): Promise<ReceiptResultDTO>;
  postGoogleReceipt(receipt: string, productId: string): Promise<ReceiptResultDTO>;

  // Required by `new EventEmitter(nativeModule)` — Expo's runtime checks
  // these exist; our mock implements them as no-ops because emit routing
  // happens through __addChangeListener / __emit on the mock state.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}
```

- [ ] **Step 1.5: Create `packages/sdk-rn/src/__tests__/_stubExpoModules.ts`**

```ts
// Vitest stub for `expo-modules-core`. The real module pulls in
// react-native (Flow syntax) which vite-node cannot parse. Tests use
// _setNativeForTesting() to inject a mock; this stub only needs to
// satisfy the imports.

export function requireNativeModule<T>(name: string): T {
  throw new Error(
    `_stubExpoModules: requireNativeModule(${JSON.stringify(name)}) was called — ` +
      `tests must call _setNativeForTesting() before any module accessor runs.`,
  );
}

type Subscription = { remove: () => void };

// Minimal EventEmitter that delegates addListener/removeListeners to the
// underlying mock's __addChangeListener / __addLogListener helpers when
// available. Mirrors the public method names of expo-modules-core's
// EventEmitter but does NOT preserve its full semantics.
export class EventEmitter {
  private nativeModule: any;
  constructor(nativeModule: any) {
    this.nativeModule = nativeModule;
  }
  addListener(eventName: string, cb: (payload: any) => void): Subscription {
    if (eventName === "onChange" && typeof this.nativeModule?.__addChangeListener === "function") {
      return { remove: this.nativeModule.__addChangeListener(cb) };
    }
    if (eventName === "onLog" && typeof this.nativeModule?.__addLogListener === "function") {
      return { remove: this.nativeModule.__addLogListener(cb) };
    }
    return { remove: () => {} };
  }
  removeAllListeners(_eventName: string): void {}
}
```

- [ ] **Step 1.6: Modify `packages/sdk-rn/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// expo-modules-core transitively imports react-native (Flow syntax)
// which vite-node cannot parse. Tests inject mocks via
// _setNativeForTesting; the stub only needs to satisfy imports.
export default defineConfig({
  resolve: {
    alias: {
      "expo-modules-core": resolve(
        __dirname,
        "src/__tests__/_stubExpoModules.ts",
      ),
    },
  },
  test: {
    environmentMatchGlobs: [
      ["**/*.test.tsx", "happy-dom"],
    ],
  },
});
```

- [ ] **Step 1.7: Rewrite `packages/sdk-rn/src/core/native.ts`**

```ts
// Lazily acquires the native Expo module the first time we touch it.
// Tests override `_setNativeForTesting` to inject a mock instead.
//
// `getEmitter()` constructs an EventEmitter against the current native
// instance — lazy so test injection is observed.

import { EventEmitter, requireNativeModule } from "expo-modules-core";
import type { RovenueModuleSpec } from "../specs/RovenueModule.types";

let instance: RovenueModuleSpec | null = null;
let emitter: EventEmitter | null = null;

export function getNative(): RovenueModuleSpec {
  if (instance) return instance;
  instance = requireNativeModule<RovenueModuleSpec>("Rovenue");
  return instance;
}

export function getEmitter(): EventEmitter {
  if (emitter) return emitter;
  emitter = new EventEmitter(getNative() as any);
  return emitter;
}

// Test seam: replaces the cached instance + forces a fresh emitter.
// Production code MUST NOT call this.
export function _setNativeForTesting(mock: RovenueModuleSpec | null): void {
  instance = mock;
  emitter = null;
}
```

- [ ] **Step 1.8: Rewrite `packages/sdk-rn/src/core/eventBridge.ts`**

```ts
// eventBridge — converts native `onChange` events into ReactiveStore
// mutations. Started by configure(); stopped by shutdown().
//
// In M6 we subscribe via Expo's EventEmitter ("onChange" event) instead
// of M5's native.addChangeListener callback. The handler is otherwise
// identical: re-fetch from native on each hint, store the result.

import { getEmitter, getNative } from "./native";
import { store } from "../store/reactiveStore";

let subscription: { remove(): void } | null = null;

export function startEventBridge(): void {
  if (subscription) return;
  const native = getNative();
  subscription = getEmitter().addListener("onChange", async (payload: { event: string }) => {
    try {
      switch (payload.event) {
        case "IDENTITY_CHANGED": {
          const u = await native.currentUser();
          store.set("user", u);
          break;
        }
        case "ENTITLEMENTS_CHANGED": {
          const all = await native.entitlementsAll();
          store.set("entitlementsAll", all);
          for (const ent of all) {
            store.set(`entitlement:${ent.id}`, ent);
          }
          break;
        }
        case "CREDIT_BALANCE_CHANGED": {
          const balance = await native.creditBalance();
          store.set("creditBalance", balance);
          break;
        }
        default:
          break;
      }
    } catch {
      // Best-effort: a refresh failure here cannot crash the bridge.
    }
  });
}

export function stopEventBridge(): void {
  subscription?.remove();
  subscription = null;
}
```

- [ ] **Step 1.9: Rewrite `packages/sdk-rn/src/__tests__/_mockNative.ts`**

```ts
// Shared mock for RovenueModuleSpec — every test that touches the
// native layer uses this. Provides:
//   - All 15 façade methods as vi.fn() with reasonable default behaviour
//   - addListener / removeListeners (Expo EventEmitter wire methods,
//     no-ops since the stub's EventEmitter delegates to __addChangeListener)
//   - __addChangeListener(cb) / __emit(event)         — change-event channel
//   - __addLogListener(cb) / __emitLog(entry)         — log-event channel
//   - __state — mutable test fixture state

import { vi } from "vitest";
import type {
  EntitlementDTO,
  LogEntryDTO,
  ReceiptResultDTO,
  RovenueModuleSpec,
  UserDTO,
} from "../specs/RovenueModule.types";

export type MockNative = RovenueModuleSpec & {
  __state: {
    user: UserDTO;
    entitlements: Map<string, EntitlementDTO>;
    creditBalance: number;
    changeListeners: Array<(payload: { event: string }) => void>;
    logListeners: Array<(entry: LogEntryDTO) => void>;
  };
  __emit(event: string): void;
  __emitLog(entry: LogEntryDTO): void;
  __addChangeListener(cb: (payload: { event: string }) => void): () => void;
  __addLogListener(cb: (entry: LogEntryDTO) => void): () => void;
};

export function makeMockNative(): MockNative {
  const state = {
    user: { anonId: "anon_test", knownUserId: null } as UserDTO,
    entitlements: new Map<string, EntitlementDTO>(),
    creditBalance: 0,
    changeListeners: [] as Array<(payload: { event: string }) => void>,
    logListeners: [] as Array<(entry: LogEntryDTO) => void>,
  };

  const mock: MockNative = {
    __state: state,
    __emit(event: string) {
      state.changeListeners.forEach((cb) => cb({ event }));
    },
    __emitLog(entry: LogEntryDTO) {
      state.logListeners.forEach((cb) => cb(entry));
    },
    __addChangeListener(cb) {
      state.changeListeners.push(cb);
      return () => {
        const i = state.changeListeners.indexOf(cb);
        if (i >= 0) state.changeListeners.splice(i, 1);
      };
    },
    __addLogListener(cb) {
      state.logListeners.push(cb);
      return () => {
        const i = state.logListeners.indexOf(cb);
        if (i >= 0) state.logListeners.splice(i, 1);
      };
    },
    configure: vi.fn(),
    shutdown: vi.fn(),
    setForeground: vi.fn(),
    getVersion: vi.fn(() => "0.1.0"),
    currentUser: vi.fn(async () => state.user),
    identify: vi.fn(async (knownUserId: string) => {
      state.user = { ...state.user, knownUserId };
      mock.__emit("IDENTITY_CHANGED");
    }),
    entitlement: vi.fn(async (id: string) => state.entitlements.get(id) ?? null),
    entitlementsAll: vi.fn(async () => Array.from(state.entitlements.values())),
    refreshEntitlements: vi.fn(async () => {
      mock.__emit("ENTITLEMENTS_CHANGED");
    }),
    creditBalance: vi.fn(async () => state.creditBalance),
    refreshCredits: vi.fn(async () => {
      mock.__emit("CREDIT_BALANCE_CHANGED");
    }),
    consumeCredits: vi.fn(async (amount: number) => {
      if (state.creditBalance < amount) {
        const err: any = new Error("insufficient");
        err.code = "InsufficientCredits";
        err.extras = { available: state.creditBalance };
        throw err;
      }
      state.creditBalance -= amount;
      mock.__emit("CREDIT_BALANCE_CHANGED");
      return state.creditBalance;
    }),
    postAppleReceipt: vi.fn(async (): Promise<ReceiptResultDTO> => ({
      ok: true,
      entitlementsRefreshed: true,
      creditsRefreshed: false,
    })),
    postGoogleReceipt: vi.fn(async (): Promise<ReceiptResultDTO> => ({
      ok: true,
      entitlementsRefreshed: true,
      creditsRefreshed: false,
    })),
    // Expo EventEmitter wire methods — no-op (stub's EventEmitter
    // delegates to __addChangeListener/__addLogListener instead).
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  } as unknown as MockNative;

  return mock;
}
```

NOTE: existing M5 tests call `mock.__emit("IDENTITY_CHANGED")` directly. With this rewrite that still works — `__emit` now wraps the value in `{event: ...}` to match what the eventBridge listener expects. Tests that previously asserted on `native.addChangeListener` being called need updating in Step 1.10 (api.test.ts).

- [ ] **Step 1.10: Update `packages/sdk-rn/src/__tests__/api.test.ts`**

The test for `configure forwards to native + starts event bridge` previously asserted `native.addChangeListener` was called. With the framework swap, the eventBridge subscribes via `getEmitter().addListener("onChange", …)`. Replace that assertion:

Locate this block (around line 65 in M5):

```ts
  it("configure forwards to native + starts event bridge", () => {
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com", debug: true });
    expect(native.configure).toHaveBeenCalledWith("pk_test", "https://api.example.com", true);
    expect(native.addChangeListener).toHaveBeenCalledTimes(1);
  });
```

Replace with:

```ts
  it("configure forwards to native + starts event bridge", () => {
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com", debug: true });
    expect(native.configure).toHaveBeenCalledWith("pk_test", "https://api.example.com", true);
    // Event bridge attached one change listener via the emitter.
    expect(native.__state.changeListeners.length).toBe(1);
  });
```

- [ ] **Step 1.11: Update `packages/sdk-rn/src/__tests__/eventBridge.test.ts`**

The two idempotency/restart tests previously checked `native.addChangeListener` call count. Update those to count via the emitter-backed listeners:

Locate `startEventBridge is idempotent (second call is no-op)`:

```ts
  it("startEventBridge is idempotent (second call is no-op)", () => {
    startEventBridge();
    startEventBridge();
    expect(native.addChangeListener).toHaveBeenCalledTimes(1);
  });
```

Replace with:

```ts
  it("startEventBridge is idempotent (second call is no-op)", () => {
    startEventBridge();
    startEventBridge();
    expect(native.__state.changeListeners.length).toBe(1);
  });
```

Locate `stopEventBridge unregisters and allows restart`:

```ts
  it("stopEventBridge unregisters and allows restart", () => {
    startEventBridge();
    stopEventBridge();
    startEventBridge();
    expect(native.addChangeListener).toHaveBeenCalledTimes(2);
  });
```

Replace with:

```ts
  it("stopEventBridge unregisters and allows restart", () => {
    startEventBridge();
    expect(native.__state.changeListeners.length).toBe(1);
    stopEventBridge();
    expect(native.__state.changeListeners.length).toBe(0);
    startEventBridge();
    expect(native.__state.changeListeners.length).toBe(1);
  });
```

- [ ] **Step 1.12: Update `scripts/sdk-parity.sh` — RN filter rename**

Find:

```bash
pnpm --filter @rovenue/sdk-rn test 2>&1 | tee /tmp/rovenue-rn-parity.log >/dev/null
```

Replace with:

```bash
pnpm --filter @rovenue/react-native-sdk test 2>&1 | tee /tmp/rovenue-rn-parity.log >/dev/null
```

Native build sections come in Task 11.

- [ ] **Step 1.13: Install + run baseline**

```bash
pnpm install 2>&1 | tail -10
```

Expected: `Done in …s`. Unmet peer warnings (RN wanting react@19, etc.) are pre-existing and OK.

```bash
pnpm --filter @rovenue/react-native-sdk test 2>&1 | tail -10
```

Expected: **48 tests passing** across 6 files (3 version + 6 errors + 7 reactiveStore + 6 eventBridge + 19 api + 7 hooks).

- [ ] **Step 1.14: Commit**

```bash
git add packages/sdk-rn/package.json \
        packages/sdk-rn/expo-module.config.json \
        packages/sdk-rn/vitest.config.ts \
        packages/sdk-rn/src/__tests__/_stubExpoModules.ts \
        packages/sdk-rn/src/__tests__/_mockNative.ts \
        packages/sdk-rn/src/__tests__/api.test.ts \
        packages/sdk-rn/src/__tests__/eventBridge.test.ts \
        packages/sdk-rn/src/specs/RovenueModule.types.ts \
        packages/sdk-rn/src/core/native.ts \
        packages/sdk-rn/src/core/eventBridge.ts \
        scripts/sdk-parity.sh \
        pnpm-lock.yaml
git rm packages/sdk-rn/nitro.json \
       packages/sdk-rn/src/specs/RovenueNitroSpec.nitro.ts \
       packages/sdk-rn/src/__tests__/_stubNitroModules.ts
git commit -m "feat(sdk-rn): pivot to Expo Modules, rename to @rovenue/react-native-sdk@0.1.0"
```

---

## Task 2: setLogHandler JS API + tests

**Files:**
- Create: `packages/sdk-rn/src/api/log.ts`
- Create: `packages/sdk-rn/src/__tests__/log.test.ts`
- Modify: `packages/sdk-rn/src/index.ts`

- [ ] **Step 2.1: Write the failing test — `packages/sdk-rn/src/__tests__/log.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { setLogHandler } from "../api/log";
import { makeMockNative, MockNative } from "./_mockNative";

describe("setLogHandler", () => {
  let native: MockNative;

  beforeEach(() => {
    native = makeMockNative();
    _setNativeForTesting(native);
  });
  afterEach(() => {
    setLogHandler(null);
    _setNativeForTesting(null);
  });

  it("subscribes to onLog and forwards entries", () => {
    const handler = vi.fn();
    setLogHandler(handler);
    native.__emitLog({ level: "info", message: "configure", data: undefined });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ level: "info", message: "configure", data: undefined });
  });

  it("setLogHandler(null) unsubscribes", () => {
    const handler = vi.fn();
    setLogHandler(handler);
    native.__emitLog({ level: "info", message: "first", data: undefined });
    setLogHandler(null);
    native.__emitLog({ level: "info", message: "second", data: undefined });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2.2: Run, see failure**

```bash
pnpm --filter @rovenue/react-native-sdk test log 2>&1 | tail -10
```

Expected: FAIL — `../api/log` module not found.

- [ ] **Step 2.3: Create `packages/sdk-rn/src/api/log.ts`**

```ts
// Rovenue.setLogHandler — JS-side seam for receiving bridge-level log
// events from M3/M4. The native module emits `onLog` events; we hold a
// single subscription and forward to the user-provided handler.
//
// Passing `null` removes the active subscription. Replacing a handler
// implicitly unsubscribes the prior one — there is only ever one active
// handler at a time, matching the M3/M4 façade contract.

import { getEmitter } from "../core/native";

export type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

let subscription: { remove(): void } | null = null;

export function setLogHandler(fn: ((entry: LogEntry) => void) | null): void {
  subscription?.remove();
  subscription = null;
  if (fn) {
    subscription = getEmitter().addListener("onLog", fn);
  }
}
```

- [ ] **Step 2.4: Run, see PASS**

```bash
pnpm --filter @rovenue/react-native-sdk test log 2>&1 | tail -10
```

Expected: 2 tests pass.

- [ ] **Step 2.5: Update `packages/sdk-rn/src/index.ts` — add setLogHandler to Rovenue namespace + export LogEntry**

Find this block:

```ts
import { setForeground, shutdown } from "./api/lifecycle";
import { SDK_VERSION } from "./version";
import { getNative } from "./core/native";
```

After the last import (and before `export const Rovenue`), add:

```ts
import { setLogHandler } from "./api/log";
```

Then add `setLogHandler` to the `Rovenue` namespace. Locate:

```ts
  shutdown,
  addChangeListener: (cb: (event: import("./types").ChangeEvent) => void): (() => void) => {
```

Insert `setLogHandler,` before `addChangeListener:`:

```ts
  shutdown,
  setLogHandler,
  addChangeListener: (cb: (event: import("./types").ChangeEvent) => void): (() => void) => {
```

At the bottom of the file, after `export type { RovenueConfig } …`, add:

```ts
export type { LogEntry } from "./api/log";
```

- [ ] **Step 2.6: Run full suite**

```bash
pnpm --filter @rovenue/react-native-sdk test 2>&1 | tail -10
```

Expected: **50 tests passing** (48 + 2).

- [ ] **Step 2.7: Commit**

```bash
git add packages/sdk-rn/src/api/log.ts \
        packages/sdk-rn/src/__tests__/log.test.ts \
        packages/sdk-rn/src/index.ts
git commit -m "feat(sdk-rn): Rovenue.setLogHandler(fn) JS log seam"
```

---

## Task 3: iOS Expo Module + new podspec

**Files:**
- Delete: `packages/sdk-rn/ios/HybridRovenueNitroSpec.swift`
- Delete: `packages/sdk-rn/ios/RovenueSdkRn.podspec` (M5 Nitro version)
- Create: `packages/sdk-rn/ios/RovenueSdkRn.podspec` (Expo Module convention)
- Create: `packages/sdk-rn/ios/RovenueModule.swift`

Source-only — not compiled in this task (no Xcode/CocoaPods env required). Validated by `swift -parse` syntax check + sample app build in Task 11.

- [ ] **Step 3.1: Delete the M5 Nitro Swift bridge + old podspec**

```bash
rm packages/sdk-rn/ios/HybridRovenueNitroSpec.swift
rm packages/sdk-rn/ios/RovenueSdkRn.podspec
```

- [ ] **Step 3.2: Create `packages/sdk-rn/ios/RovenueSdkRn.podspec`**

```ruby
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'RovenueSdkRn'
  s.version        = package['version']
  s.summary        = 'Rovenue React Native SDK — Expo Module bridge'
  s.homepage       = 'https://rovenue.dev'
  s.license        = { :type => 'AGPL-3.0' }
  s.authors        = 'Rovenue'
  s.platforms      = { :ios => '13.0' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.source_files   = '**/*.{h,m,swift}'

  # Expo Modules runtime — provided by the consuming app via autolinking
  s.dependency 'ExpoModulesCore'

  # M3 Swift façade — provided by the consumer's Podfile via
  # `pod 'Rovenue', :path => '<monorepo-relative path>'` injected by
  # our config plugin (plugin/withRovenueIos.ts).
  s.dependency 'Rovenue'
end
```

- [ ] **Step 3.3: Create `packages/sdk-rn/ios/RovenueModule.swift`**

```swift
// RovenueModule.swift — Expo Module bridge forwarding to the M3 Swift
// `Rovenue` singleton.
//
// Compile target: iOS 13+. Depends on:
//   - ExpoModulesCore (peer pod via Expo autolinking)
//   - Rovenue Swift module (pod :path injected by config plugin)
//
// JS surface mirrors RovenueModuleSpec in
// packages/sdk-rn/src/specs/RovenueModule.types.ts.

import ExpoModulesCore
import Rovenue

public class RovenueModule: Module {
    private var changesTask: Task<Void, Never>?
    private var logUnsubscribe: (() -> Void)?

    public func definition() -> ModuleDefinition {
        Name("Rovenue")

        // ---------------- Sync ----------------
        Function("configure") { (apiKey: String, baseUrl: String, debug: Bool) in
            try Rovenue.configure(apiKey: apiKey, baseUrl: baseUrl, debug: debug)
        }
        Function("shutdown") { Rovenue.shared.shutdown() }
        Function("setForeground") { (foreground: Bool) in
            Rovenue.shared.setForeground(foreground)
        }
        Function("getVersion") { () -> String in Rovenue.shared.version }

        // ---------------- Async ----------------
        AsyncFunction("currentUser") { () -> [String: Any?] in
            let u = await Rovenue.shared.currentUser()
            return ["anonId": u.anonId, "knownUserId": u.knownUserId as Any?]
        }
        AsyncFunction("identify") { (knownUserId: String) in
            try await Rovenue.shared.identify(knownUserId)
        }
        AsyncFunction("entitlement") { (id: String) -> [String: Any?]? in
            guard let e = await Rovenue.shared.entitlement(id) else { return nil }
            return Self.dtoFromEntitlement(e)
        }
        AsyncFunction("entitlementsAll") { () -> [[String: Any?]] in
            await Rovenue.shared.entitlementsAll().map(Self.dtoFromEntitlement)
        }
        AsyncFunction("refreshEntitlements") {
            try await Rovenue.shared.refreshEntitlements()
        }
        AsyncFunction("creditBalance") { () -> Double in
            // Long → Double is lossless up to 2^53.
            Double(await Rovenue.shared.creditBalance())
        }
        AsyncFunction("refreshCredits") { try await Rovenue.shared.refreshCredits() }
        AsyncFunction("consumeCredits") { (amount: Double, description: String?) -> Double in
            let b = try await Rovenue.shared.consumeCredits(Int64(amount), description: description)
            return Double(b)
        }
        AsyncFunction("postAppleReceipt") { (jws: String, productId: String) -> [String: Any?] in
            _ = try await Rovenue.shared.postAppleReceipt(jws, productId: productId)
            // M3 only resolves on success and guarantees both caches refreshed.
            return ["ok": true, "entitlementsRefreshed": true, "creditsRefreshed": true]
        }
        AsyncFunction("postGoogleReceipt") { (receipt: String, productId: String) -> [String: Any?] in
            _ = try await Rovenue.shared.postGoogleReceipt(receipt, productId: productId)
            return ["ok": true, "entitlementsRefreshed": true, "creditsRefreshed": true]
        }

        // ---------------- Events ----------------
        Events("onChange", "onLog")

        OnStartObserving {
            self.changesTask = Task { [weak self] in
                for await event in Rovenue.shared.changes {
                    self?.sendEvent("onChange", ["event": Self.eventName(event)])
                }
            }
            self.logUnsubscribe = Rovenue.shared.setLogHandler { [weak self] entry in
                self?.sendEvent("onLog", [
                    "level": entry.level,
                    "message": entry.message,
                    "data": entry.data as Any?,
                ])
            }
        }
        OnStopObserving {
            self.changesTask?.cancel()
            self.changesTask = nil
            self.logUnsubscribe?()
            self.logUnsubscribe = nil
        }
    }

    private static func dtoFromEntitlement(_ e: Entitlement) -> [String: Any?] {
        [
            "id": e.id,
            "active": e.isActive,
            "expiresAt": e.expiresIso as Any?,
            "productId": e.productIdentifier,
        ]
    }
    private static func eventName(_ event: ChangeEvent) -> String {
        switch event {
        case .entitlementsChanged: return "ENTITLEMENTS_CHANGED"
        case .identityChanged:     return "IDENTITY_CHANGED"
        case .creditBalanceChanged: return "CREDIT_BALANCE_CHANGED"
        }
    }
}
```

NOTE: This file references `Rovenue.shared.setLogHandler` and `LogEntry`, which are added to M3 in Task 5. If Task 5 hasn't run yet, this file won't compile against M3 — but M5 native files were also source-only, and the parity gate (Task 11) runs after both. The dependency ordering is: Task 5 (M3 setLogHandler) before Task 11 (sample build).

- [ ] **Step 3.4: Syntax-check (best effort)**

```bash
cd packages/sdk-rn/ios && swift -parse RovenueModule.swift 2>&1 | tail -10
```

Expected: errors about missing `ExpoModulesCore` / `Rovenue` modules — acceptable (resolve at pod-install time). Pure-Swift parse errors (typos, braces) MUST NOT appear; fix them if reported.

- [ ] **Step 3.5: Commit**

```bash
git add packages/sdk-rn/ios/RovenueSdkRn.podspec \
        packages/sdk-rn/ios/RovenueModule.swift
git rm packages/sdk-rn/ios/HybridRovenueNitroSpec.swift 2>/dev/null || true
git commit -m "feat(sdk-rn): iOS Expo Module bridge to M3 Rovenue"
```

---

## Task 4: Android Expo Module + new build.gradle

**Files:**
- Delete: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/HybridRovenueNitroSpec.kt`
- Delete: `packages/sdk-rn/android/build.gradle.kts` (M5 Nitro version)
- Create: `packages/sdk-rn/android/build.gradle` (Expo Module convention)
- Create: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`
- (Verify unchanged: `packages/sdk-rn/android/src/main/AndroidManifest.xml`)

Source-only. Not compiled in this task.

- [ ] **Step 4.1: Delete the M5 Nitro Kotlin bridge + old gradle**

```bash
rm packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/HybridRovenueNitroSpec.kt
rm packages/sdk-rn/android/build.gradle.kts
```

- [ ] **Step 4.2: Create `packages/sdk-rn/android/build.gradle`**

```groovy
apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'

group = 'dev.rovenue.sdkrn'
version = '0.1.0'

def expoModulesCorePlugin = new File(
    project(':expo-modules-core').projectDir,
    'ExpoModulesCorePlugin.gradle'
)
if (expoModulesCorePlugin.exists()) {
    apply from: expoModulesCorePlugin
    applyKotlinExpoModulesCorePlugin()
}

android {
    namespace 'dev.rovenue.sdkrn'
    compileSdkVersion safeExtGet('compileSdkVersion', 34)

    defaultConfig {
        minSdkVersion safeExtGet('minSdkVersion', 24)
        targetSdkVersion safeExtGet('targetSdkVersion', 34)
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = '17'
    }
}

dependencies {
    implementation project(':expo-modules-core')
    // M4 Kotlin façade — provided by the consumer's settings.gradle
    // via composite build (includeBuild) + dep coordinate injected by
    // our config plugin (plugin/withRovenueAndroid.ts).
    implementation 'dev.rovenue:sdk:0.1.0'
    implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0'
}

// Helper for Expo's project-property safe lookups (provided when this
// build.gradle is applied inside an Expo project; defaults work for
// standalone evaluation).
def safeExtGet(prop, fallback) {
    rootProject.ext.has(prop) ? rootProject.ext.get(prop) : fallback
}
```

NOTE: Expo convention uses Groovy `build.gradle` (not `.kts`) for module packages. The Expo autolinker expects this filename.

- [ ] **Step 4.3: Create `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`**

```kotlin
// RovenueModule.kt — Expo Module bridge forwarding to the M4 Kotlin
// `Rovenue` singleton.
//
// Compile target: Android 24+ (JVM 17). Depends on:
//   - expo-modules-core (provided via Expo autolinking)
//   - dev.rovenue:sdk (provided via Gradle composite build, injected
//     by the config plugin)
//
// JS surface mirrors RovenueModuleSpec in
// packages/sdk-rn/src/specs/RovenueModule.types.ts.

package dev.rovenue.sdkrn

import dev.rovenue.sdk.LogEntry
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Entitlement
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

class RovenueModule : Module() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var changesJob: Job? = null
    private var logUnsub: (() -> Unit)? = null

    override fun definition() = ModuleDefinition {
        Name("Rovenue")

        // ---------------- Sync ----------------
        Function("configure") { apiKey: String, baseUrl: String, debug: Boolean ->
            Rovenue.configure(apiKey, baseUrl, debug)
        }
        Function("shutdown") { Rovenue.shared.shutdown() }
        Function("setForeground") { foreground: Boolean ->
            Rovenue.shared.setForeground(foreground)
        }
        Function("getVersion") { Rovenue.shared.version }

        // ---------------- Async ----------------
        AsyncFunction("currentUser") Coroutine { ->
            val u = Rovenue.shared.currentUser()
            mapOf("anonId" to u.anonId, "knownUserId" to u.knownUserId)
        }
        AsyncFunction("identify") Coroutine { knownUserId: String ->
            Rovenue.shared.identify(knownUserId)
        }
        AsyncFunction("entitlement") Coroutine { id: String ->
            Rovenue.shared.entitlement(id)?.let(::dtoFromEntitlement)
        }
        AsyncFunction("entitlementsAll") Coroutine { ->
            Rovenue.shared.entitlementsAll().map(::dtoFromEntitlement)
        }
        AsyncFunction("refreshEntitlements") Coroutine { ->
            Rovenue.shared.refreshEntitlements()
        }
        AsyncFunction("creditBalance") Coroutine { ->
            Rovenue.shared.creditBalance().toDouble()
        }
        AsyncFunction("refreshCredits") Coroutine { -> Rovenue.shared.refreshCredits() }
        AsyncFunction("consumeCredits") Coroutine { amount: Double, description: String? ->
            Rovenue.shared.consumeCredits(amount.toLong(), description).toDouble()
        }
        AsyncFunction("postAppleReceipt") Coroutine { jws: String, productId: String ->
            Rovenue.shared.postAppleReceipt(jws, productId)
            mapOf("ok" to true, "entitlementsRefreshed" to true, "creditsRefreshed" to true)
        }
        AsyncFunction("postGoogleReceipt") Coroutine { receipt: String, productId: String ->
            Rovenue.shared.postGoogleReceipt(receipt, productId)
            mapOf("ok" to true, "entitlementsRefreshed" to true, "creditsRefreshed" to true)
        }

        // ---------------- Events ----------------
        Events("onChange", "onLog")

        OnStartObserving {
            changesJob = scope.launch {
                Rovenue.shared.changes.collect { event ->
                    sendEvent("onChange", mapOf("event" to event.name))
                }
            }
            logUnsub = Rovenue.shared.setLogHandler { entry: LogEntry ->
                sendEvent("onLog", mapOf(
                    "level" to entry.level,
                    "message" to entry.message,
                    "data" to entry.data,
                ))
            }
        }
        OnStopObserving {
            changesJob?.cancel()
            changesJob = null
            logUnsub?.invoke()
            logUnsub = null
        }
    }

    private fun dtoFromEntitlement(e: Entitlement): Map<String, Any?> = mapOf(
        "id"        to e.id,
        "active"    to e.isActive,
        "expiresAt" to e.expiresIso,
        "productId" to e.productIdentifier,
    )
}
```

NOTE: References `dev.rovenue.sdk.LogEntry` and `Rovenue.shared.setLogHandler` — both added to M4 in Task 7. Source-only; build deferred to Task 11.

- [ ] **Step 4.4: Verify manifest is intact**

```bash
cat packages/sdk-rn/android/src/main/AndroidManifest.xml
```

Expected: `<manifest … package="dev.rovenue.sdkrn">` block, two-line file. Do NOT modify.

- [ ] **Step 4.5: Commit**

```bash
git add packages/sdk-rn/android/build.gradle \
        packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt
git rm packages/sdk-rn/android/build.gradle.kts \
       packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/HybridRovenueNitroSpec.kt 2>/dev/null || true
git commit -m "feat(sdk-rn): Android Expo Module bridge to M4 Rovenue"
```

---

## Task 5: M3 Swift — LogEntry + setLogHandler + emit calls + tests

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Create: `packages/sdk-swift/Tests/RovenueTests/LogHandlerTests.swift`

- [ ] **Step 5.1: Read existing Rovenue.swift to find insertion points**

```bash
grep -n "^public final class Rovenue\|^    public static func configure\|^    public func identify\|^}" packages/sdk-swift/Sources/Rovenue/Rovenue.swift | head -30
```

Identify: class declaration line, `configure(apiKey:baseUrl:debug:)`, async method bodies, closing brace.

- [ ] **Step 5.2: Write the failing tests — `packages/sdk-swift/Tests/RovenueTests/LogHandlerTests.swift`**

```swift
import XCTest
@testable import Rovenue

final class LogHandlerTests: XCTestCase {

    override func setUp() async throws {
        try await super.setUp()
        try Rovenue.configure(apiKey: "pk_test", baseUrl: "https://api.test", debug: true)
    }

    override func tearDown() async throws {
        Rovenue.shared.shutdown()
        try await super.tearDown()
    }

    func testHandlerReceivesEntries() async throws {
        let captured = LockedBox<[LogEntry]>([])
        _ = Rovenue.shared.setLogHandler { entry in
            captured.with { $0.append(entry) }
        }
        // Trigger an emit via identify — entry + ok path.
        try? await Rovenue.shared.identify("user_log_test")
        let entries = captured.value
        XCTAssertGreaterThan(entries.count, 0)
        XCTAssertTrue(entries.contains { $0.message == "identify" && $0.level == "info" })
        // Privacy: handler MUST NOT receive the raw knownUserId string.
        XCTAssertFalse(entries.contains { $0.message.contains("user_log_test") })
    }

    func testUnsubscribeStopsCalls() async throws {
        let captured = LockedBox<[LogEntry]>([])
        let unsub = Rovenue.shared.setLogHandler { entry in
            captured.with { $0.append(entry) }
        }
        unsub()
        try? await Rovenue.shared.identify("user_unsub_test")
        XCTAssertEqual(captured.value.count, 0)
    }
}

// Tiny thread-safe box for test capture (avoids @Sendable closure warnings).
private final class LockedBox<T> {
    private var _value: T
    private let lock = NSLock()
    init(_ initial: T) { self._value = initial }
    var value: T { lock.lock(); defer { lock.unlock() }; return _value }
    func with(_ block: (inout T) -> Void) {
        lock.lock(); defer { lock.unlock() }; block(&_value)
    }
}
```

- [ ] **Step 5.3: Run, see failure**

```bash
cd packages/sdk-swift && DYLD_LIBRARY_PATH="$(pwd)/../../target/release" swift test --filter LogHandlerTests 2>&1 | tail -20
```

Expected: compile errors — `LogEntry` not found, `setLogHandler` not found.

- [ ] **Step 5.4: Add LogEntry + setLogHandler to `Rovenue.swift`**

Open `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` and add at the top, after the existing `import Foundation`:

```swift
// MARK: - LogEntry

/// A single log event emitted by the Rovenue façade. Forwarded to any
/// handler registered via `setLogHandler`. The `message` field is a
/// fixed string per emit site (no user input interpolation); the `data`
/// field is currently always `nil` (reserved for future structured
/// payloads, which MUST NOT include PII).
public struct LogEntry: Sendable {
    public let level: String   // "debug" | "info" | "warn" | "error"
    public let message: String
    public let data: [String: String]?

    public init(level: String, message: String, data: [String: String]? = nil) {
        self.level = level
        self.message = message
        self.data = data
    }
}
```

Inside the `Rovenue` class, after the singleton plumbing block (after `_shared = instance`), add:

```swift
    // MARK: - Log handlers
    //
    // Static dictionary (not cleared on configure-twice) so consumers
    // can install a handler once at app start and reconfigure without
    // silently losing it.

    private static let logLock = NSLock()
    private static var logHandlers: [UUID: (LogEntry) -> Void] = [:]

    /// Register a log handler that receives bridge-level events
    /// (configure / identify / refresh / receipt / shutdown).
    /// Returns an unsubscribe closure.
    @discardableResult
    public func setLogHandler(_ handler: @escaping (LogEntry) -> Void) -> () -> Void {
        let id = UUID()
        Self.logLock.lock(); Self.logHandlers[id] = handler; Self.logLock.unlock()
        return {
            Self.logLock.lock(); Self.logHandlers.removeValue(forKey: id); Self.logLock.unlock()
        }
    }

    internal static func emit(_ entry: LogEntry) {
        logLock.lock(); let snapshot = Array(logHandlers.values); logLock.unlock()
        snapshot.forEach { $0(entry) }
    }
```

- [ ] **Step 5.5: Add `emit` calls inside each public façade method**

For each of these methods in `Rovenue.swift`, wrap the body with entry + exit emits. Example shown for `identify`:

Find:

```swift
    public func identify(_ knownUserId: String) async throws {
        try await dispatcher.run { try await self.core.identify(knownUserId: knownUserId) }
    }
```

Replace with:

```swift
    public func identify(_ knownUserId: String) async throws {
        Self.emit(LogEntry(level: "info", message: "identify"))
        do {
            try await dispatcher.run { try await self.core.identify(knownUserId: knownUserId) }
            Self.emit(LogEntry(level: "info", message: "identify ok"))
        } catch {
            Self.emit(LogEntry(level: "error", message: "identify failed: \(error.localizedDescription)"))
            throw error
        }
    }
```

Apply the same entry + ok/error pattern to:
- `refreshEntitlements()` — message `"refreshEntitlements"` / `"refreshEntitlements ok"` / `"refreshEntitlements failed: ..."`
- `refreshCredits()` — message `"refreshCredits"` / `"refreshCredits ok"` / `"refreshCredits failed: ..."`
- `consumeCredits(_:description:)` — message `"consumeCredits"` (no amount/description interpolation)
- `postAppleReceipt(_:productId:)` — message `"postAppleReceipt"` (no jws interpolation)
- `postGoogleReceipt(_:productId:)` — message `"postGoogleReceipt"` (no token interpolation)

For sync methods (`configure`, `shutdown`, `setForeground`), add a single entry emit (no ok/error since they don't propagate errors the same way). Example for `configure`:

```swift
    public static func configure(apiKey: String, baseUrl: String, debug: Bool = false) throws {
        emit(LogEntry(level: "info", message: "configure"))
        // ... existing body unchanged ...
    }
```

For `shutdown`:

```swift
    public func shutdown() {
        Self.emit(LogEntry(level: "info", message: "shutdown"))
        // ... existing body unchanged ...
    }
```

NOTE: emit calls intentionally take no parameters from user input. `LogEntry.message` is a literal at every emit site. This satisfies the privacy contract from the spec.

- [ ] **Step 5.6: Run tests, expect PASS**

```bash
cd packages/sdk-swift && DYLD_LIBRARY_PATH="$(pwd)/../../target/release" swift test 2>&1 | tail -15
```

Expected: all tests pass including 2 new LogHandlerTests. Existing 30 → 32 passing.

If a different number of tests existed at the start of M6, use the new count; the +2 from this task is what matters.

- [ ] **Step 5.7: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift \
        packages/sdk-swift/Tests/RovenueTests/LogHandlerTests.swift
git commit -m "feat(sdk-swift): setLogHandler + LogEntry + emit hooks in M3 façade"
```

---

## Task 6: M3 Rovenue.podspec

**Files:**
- Create: `packages/sdk-swift/Rovenue.podspec`

Source-only — no tests. Validates by being parseable as Ruby (pod CLI verification deferred to Task 11).

- [ ] **Step 6.1: Create `packages/sdk-swift/Rovenue.podspec`**

```ruby
# Rovenue.podspec — CocoaPods wrapper for the M3 Swift façade.
# M3 is SPM-primary; this podspec exists so the RN sample app (and any
# Expo / bare RN consumer) can pull the M3 sources via `pod 'Rovenue',
# :path => '...'`. CocoaPods Trunk publish is deferred to M7.

Pod::Spec.new do |s|
  s.name             = 'Rovenue'
  s.version          = '0.1.0'
  s.summary          = 'Rovenue Swift façade'
  s.homepage         = 'https://rovenue.dev'
  s.license          = { :type => 'AGPL-3.0' }
  s.authors          = 'Rovenue'
  s.platforms        = { :ios => '13.0' }
  s.swift_version    = '5.9'
  s.source           = { :path => '.' }
  s.source_files     = 'Sources/Rovenue/**/*.swift'
  s.vendored_libraries = 'Sources/Rovenue/librovenue.a'
end
```

- [ ] **Step 6.2: Syntax-check (best effort)**

```bash
ruby -c packages/sdk-swift/Rovenue.podspec
```

Expected: `Syntax OK`. (No CocoaPods install — that runs in Task 11's sample build.)

- [ ] **Step 6.3: Commit**

```bash
git add packages/sdk-swift/Rovenue.podspec
git commit -m "feat(sdk-swift): add Rovenue.podspec for path-based RN consumer linking"
```

---

## Task 7: M4 Kotlin — LogEntry + setLogHandler + emit calls + Gradle coords + tests

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Modify: `packages/sdk-kotlin/build.gradle.kts`
- Create: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/LogHandlerTest.kt`

- [ ] **Step 7.1: Write the failing test — `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/LogHandlerTest.kt`**

```kotlin
package dev.rovenue.sdk

import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LogHandlerTest {

    @BeforeTest
    fun setup() {
        Rovenue.configure(apiKey = "pk_test", baseUrl = "https://api.test", debug = true)
    }

    @AfterTest
    fun teardown() {
        Rovenue.resetForTesting()
    }

    @Test
    fun handlerReceivesEntries() = runBlocking {
        val captured = mutableListOf<LogEntry>()
        Rovenue.shared.setLogHandler { entry -> synchronized(captured) { captured.add(entry) } }
        runCatching { Rovenue.shared.identify("user_log_test") }
        val entries = synchronized(captured) { captured.toList() }
        assertTrue(entries.isNotEmpty(), "handler should have received entries")
        assertTrue(entries.any { it.message == "identify" && it.level == "info" })
        // Privacy: handler MUST NOT receive the raw knownUserId string.
        assertFalse(entries.any { it.message.contains("user_log_test") })
    }

    @Test
    fun unsubscribeStopsCalls() = runBlocking {
        val captured = mutableListOf<LogEntry>()
        val unsub = Rovenue.shared.setLogHandler { entry -> synchronized(captured) { captured.add(entry) } }
        unsub()
        runCatching { Rovenue.shared.identify("user_unsub_test") }
        assertEquals(0, synchronized(captured) { captured.size })
    }
}
```

- [ ] **Step 7.2: Run, see failure (only if gradle on PATH)**

```bash
if command -v gradle >/dev/null 2>&1; then
  cd packages/sdk-kotlin && gradle test --tests "*LogHandlerTest*" --no-daemon --console=plain 2>&1 | tail -15
else
  echo "gradle not available — failure expected at write-time, will run after impl in Step 7.6"
fi
```

Expected (if gradle available): compile errors — `LogEntry` not found, `setLogHandler` not found.

- [ ] **Step 7.3: Add LogEntry + setLogHandler to `Rovenue.kt`**

Open `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`. After the existing imports (after `import dev.rovenue.sdk.internal.ObserverBridge`), add:

```kotlin
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
```

Above the `class Rovenue private constructor(...)` line, add the LogEntry data class:

```kotlin
/**
 * A single log event emitted by the Rovenue façade. Forwarded to any
 * handler registered via [Rovenue.setLogHandler]. The `message` field
 * is a fixed string per emit site (no user-input interpolation); the
 * `data` field is currently always `null` (reserved for future
 * structured payloads, which MUST NOT include PII).
 */
data class LogEntry(
    val level: String,                    // "debug" | "info" | "warn" | "error"
    val message: String,
    val data: Map<String, String>? = null,
)
```

Inside the `Rovenue` class's `companion object` (after `resetForTesting()`), add:

```kotlin
        // -----------------------------------------------------------
        // Log handlers — static, intentionally NOT cleared on
        // configure-twice or resetForTesting. Consumers install a
        // handler once at app start; reconfiguring should not drop it.
        // -----------------------------------------------------------

        private val logLock = ReentrantLock()
        private val logHandlers: MutableMap<UUID, (LogEntry) -> Unit> = mutableMapOf()

        internal fun emit(entry: LogEntry) {
            val snapshot = logLock.withLock { logHandlers.values.toList() }
            snapshot.forEach { it(entry) }
        }
```

Inside the `Rovenue` class instance methods area (after `private fun shutdownInternal()`), add:

```kotlin
    /**
     * Register a log handler that receives bridge-level events
     * (configure / identify / refresh / receipt / shutdown).
     * Returns an unsubscribe lambda.
     */
    fun setLogHandler(handler: (LogEntry) -> Unit): () -> Unit {
        val id = UUID.randomUUID()
        Rovenue.logLock.withLock { Rovenue.logHandlers[id] = handler }
        return { Rovenue.logLock.withLock { Rovenue.logHandlers.remove(id) } }
    }
```

- [ ] **Step 7.4: Add `emit` calls inside each public façade method**

Apply the entry + ok/error pattern. Example for `identify`:

Find:

```kotlin
    @Throws(RovenueException::class)
    suspend fun identify(knownUserId: String) {
        dispatcher.run { core.identify(knownUserId) }
    }
```

Replace with:

```kotlin
    @Throws(RovenueException::class)
    suspend fun identify(knownUserId: String) {
        emit(LogEntry(level = "info", message = "identify"))
        try {
            dispatcher.run { core.identify(knownUserId) }
            emit(LogEntry(level = "info", message = "identify ok"))
        } catch (e: Throwable) {
            emit(LogEntry(level = "error", message = "identify failed: ${e.message ?: e.javaClass.simpleName}"))
            throw e
        }
    }
```

Apply the same pattern to:
- `refreshEntitlements()` — `"refreshEntitlements"` / `" ok"` / `" failed: ..."`
- `refreshCredits()` — `"refreshCredits"` / `" ok"` / `" failed: ..."`
- `consumeCredits(amount, description)` — `"consumeCredits"` (no amount interpolation)
- `postAppleReceipt(jws, productId)` — `"postAppleReceipt"` (no jws interpolation)
- `postGoogleReceipt(receipt, productId)` — `"postGoogleReceipt"` (no token interpolation)

For sync methods, add single entry emit:
- `configure(apiKey, baseUrl, debug)` in companion object — `emit(LogEntry("info", "configure"))` at top of body
- `setForeground(foreground)` instance method — `emit(LogEntry("info", "setForeground"))` at top
- `shutdown()` instance method — `emit(LogEntry("info", "shutdown"))` at top

Note: `emit` is a companion object function. From inside instance methods, call as `emit(...)` (Kotlin resolves to companion). From a top-level companion function like `configure`, also `emit(...)` works because it's same companion.

- [ ] **Step 7.5: Add group/version/publication to `packages/sdk-kotlin/build.gradle.kts`**

Read the existing file first:

```bash
cat packages/sdk-kotlin/build.gradle.kts
```

At the top of the file (after any `plugins { ... }` block), add or update:

```kotlin
group = "dev.rovenue"
version = "0.1.0"
```

At the bottom of the file (or merge into existing publishing block if present), add:

```kotlin
publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            groupId = "dev.rovenue"
            artifactId = "sdk"
            version = "0.1.0"
        }
    }
}
```

If the existing file already has a `publishing { ... }` block (M4 may have wired `publishToMavenLocal`), merge — do not duplicate.

If `apply plugin: "maven-publish"` or `id("maven-publish")` is not already present in the plugins block, add it:

```kotlin
plugins {
    // ... existing plugins ...
    `maven-publish`
}
```

- [ ] **Step 7.6: Run tests, expect PASS**

```bash
if command -v gradle >/dev/null 2>&1; then
  cd packages/sdk-kotlin && gradle test --no-daemon --console=plain 2>&1 | tail -15
else
  echo "gradle SKIPPED — tests will be validated in Task 11 parity gate"
fi
```

Expected (if gradle available): existing 16 + 2 new = 18 tests pass.

- [ ] **Step 7.7: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt \
        packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/LogHandlerTest.kt \
        packages/sdk-kotlin/build.gradle.kts
git commit -m "feat(sdk-kotlin): setLogHandler + LogEntry + emit hooks; Maven coords for composite build"
```

---

## Task 8: Config plugin (iOS + Android) + tsconfig.plugin + app.plugin.js

**Files:**
- Create: `packages/sdk-rn/plugin/index.ts`
- Create: `packages/sdk-rn/plugin/withRovenueIos.ts`
- Create: `packages/sdk-rn/plugin/withRovenueAndroid.ts`
- Create: `packages/sdk-rn/app.plugin.js`
- Create: `packages/sdk-rn/tsconfig.plugin.json`

The plugin output is built via `tsc -p tsconfig.plugin.json` (separate from the main TS build in Task 9). Output goes to `plugin/build/`.

- [ ] **Step 8.1: Create `packages/sdk-rn/plugin/withRovenueIos.ts`**

```ts
// withRovenueIos — Expo config plugin mod that injects the M3 Swift
// pod into the consumer's Podfile so RovenueModule (sdk-rn's bridge)
// can link against it.
//
// M6 hard-codes the monorepo-relative path. M7 will support an
// option-driven external path and/or a Trunk-published pod.

import { ConfigPlugin, withDangerousMod } from "@expo/config-plugins";
import * as fs from "node:fs";
import * as path from "node:path";

type Options = { rovenueSwiftPath?: string } | undefined;

export const withRovenueIos: ConfigPlugin<Options> = (config, opts) => {
  return withDangerousMod(config, ["ios", async (cfg) => {
    const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
    if (!fs.existsSync(podfile)) return cfg;

    const contents = fs.readFileSync(podfile, "utf8");
    if (contents.includes("pod 'Rovenue'")) return cfg;

    const rovenuePath = opts?.rovenueSwiftPath ?? "../../../packages/sdk-swift";
    const podLine = `  pod 'Rovenue', :path => '${rovenuePath}'`;

    // Inject after the first `target 'XYZ' do` line.
    const patched = contents.replace(
      /(target\s+['"][^'"]+['"]\s+do)/,
      `$1\n${podLine}`,
    );
    fs.writeFileSync(podfile, patched);
    return cfg;
  }]);
};
```

- [ ] **Step 8.2: Create `packages/sdk-rn/plugin/withRovenueAndroid.ts`**

```ts
// withRovenueAndroid — Expo config plugin mods that wire the M4 Kotlin
// façade into the consumer's Gradle build via composite build
// (settings.gradle.kts includeBuild + app/build.gradle dep).
//
// M6 hard-codes the monorepo-relative path. M7 will support an
// option-driven external path and/or a Maven Central artifact.

import { ConfigPlugin, withSettingsGradle, withAppBuildGradle } from "@expo/config-plugins";

type Options = { rovenueKotlinPath?: string } | undefined;

export const withRovenueAndroid: ConfigPlugin<Options> = (config, opts) => {
  const kotlinPath = opts?.rovenueKotlinPath ?? "../../../packages/sdk-kotlin";

  config = withSettingsGradle(config, (cfg) => {
    const line = `includeBuild("${kotlinPath}")`;
    if (!cfg.modResults.contents.includes(line)) {
      cfg.modResults.contents = `${line}\n${cfg.modResults.contents}`;
    }
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    const dep = `    implementation("dev.rovenue:sdk:0.1.0")`;
    if (!cfg.modResults.contents.includes("dev.rovenue:sdk")) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/,
        `dependencies {\n${dep}`,
      );
    }
    return cfg;
  });

  return config;
};
```

- [ ] **Step 8.3: Create `packages/sdk-rn/plugin/index.ts`**

```ts
// @rovenue/react-native-sdk — Expo config plugin entry.
//
// Used by consumers via `"plugins": ["@rovenue/react-native-sdk"]` in
// their app.json. At prebuild time we patch the consumer's iOS Podfile
// and Android settings.gradle/app build.gradle to wire the M3 Swift +
// M4 Kotlin façades.

import { ConfigPlugin } from "@expo/config-plugins";
import { withRovenueIos } from "./withRovenueIos";
import { withRovenueAndroid } from "./withRovenueAndroid";

export type RovenueConfigOptions = {
  rovenueSwiftPath?: string;
  rovenueKotlinPath?: string;
};

const withRovenue: ConfigPlugin<RovenueConfigOptions | void> = (config, opts) => {
  config = withRovenueIos(config, opts ?? undefined);
  config = withRovenueAndroid(config, opts ?? undefined);
  return config;
};

export default withRovenue;
```

- [ ] **Step 8.4: Create `packages/sdk-rn/app.plugin.js`**

```js
// Expo loads `app.plugin.js` from the package root when the consumer
// adds the package to `"plugins"` in app.json. We delegate to the
// compiled TS plugin entry under plugin/build/.
module.exports = require("./plugin/build/index").default;
```

- [ ] **Step 8.5: Create `packages/sdk-rn/tsconfig.plugin.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "outDir": "./plugin/build",
    "rootDir": "./plugin"
  },
  "include": ["plugin/**/*.ts"],
  "exclude": ["plugin/build", "node_modules"]
}
```

- [ ] **Step 8.6: Build the plugin**

```bash
cd packages/sdk-rn && pnpm exec tsc -p tsconfig.plugin.json 2>&1 | tail -10
```

Expected: no errors. Verify `plugin/build/index.js` exists:

```bash
ls packages/sdk-rn/plugin/build/
```

Expected: `index.js`, `withRovenueIos.js`, `withRovenueAndroid.js`.

NOTE: `plugin/build/` should be gitignored. Confirm:

```bash
grep -E "^plugin/build|^\\*\\*/build" .gitignore packages/sdk-rn/.gitignore 2>/dev/null
```

If not ignored, add to `packages/sdk-rn/.gitignore` (create if missing):

```bash
echo "plugin/build/" >> packages/sdk-rn/.gitignore
```

- [ ] **Step 8.7: Commit**

```bash
git add packages/sdk-rn/plugin/index.ts \
        packages/sdk-rn/plugin/withRovenueIos.ts \
        packages/sdk-rn/plugin/withRovenueAndroid.ts \
        packages/sdk-rn/app.plugin.js \
        packages/sdk-rn/tsconfig.plugin.json \
        packages/sdk-rn/.gitignore 2>/dev/null
git commit -m "feat(sdk-rn): Expo config plugin — Podfile + settings.gradle mods"
```

---

## Task 9: TS dual format via tsup

**Files:**
- Create: `packages/sdk-rn/tsup.config.ts`
- Modify: `packages/sdk-rn/package.json` (scripts, main, module, types, exports)
- Modify: `packages/sdk-rn/tsconfig.json` (exclude additions)

- [ ] **Step 9.1: Add `tsup` to devDependencies**

```bash
cd packages/sdk-rn && pnpm add -D tsup@^8.0.0 2>&1 | tail -5
```

- [ ] **Step 9.2: Create `packages/sdk-rn/tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

// Builds ESM + CJS + .d.ts for the JS surface. The Expo config plugin
// is built separately via tsconfig.plugin.json (Task 8) because it
// must be plain CommonJS — Expo loads it via `require()`.

export default defineConfig({
  entry: ["src/index.ts", "src/version.ts"],
  format: ["esm", "cjs"],
  dts: true,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  target: "es2020",
  external: [
    "react",
    "react-native",
    "expo",
    "expo-modules-core",
    "@rovenue/shared",
  ],
});
```

- [ ] **Step 9.3: Update `packages/sdk-rn/package.json` — exports + scripts**

Replace the existing `main`, `types`, `exports`, and `scripts` blocks (keep deps blocks intact). Final values:

```json
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./version": {
      "types": "./dist/version.d.ts",
      "import": "./dist/version.js",
      "require": "./dist/version.cjs"
    },
    "./app.plugin": "./app.plugin.js"
  },
  "files": [
    "dist",
    "ios",
    "android",
    "plugin/build",
    "app.plugin.js",
    "expo-module.config.json"
  ],
  "scripts": {
    "build": "pnpm build:js && pnpm build:plugin",
    "build:js": "tsup",
    "build:plugin": "tsc -p tsconfig.plugin.json",
    "test": "vitest run"
  },
```

- [ ] **Step 9.4: Modify `packages/sdk-rn/tsconfig.json` — exclude additions**

Open `packages/sdk-rn/tsconfig.json` and update the `exclude` array (preserving any existing entries):

```json
  "exclude": ["dist", "node_modules", "plugin", "**/*.test.ts", "**/*.test.tsx"]
```

(`plugin/` is excluded from the main tsc/tsup build; it has its own `tsconfig.plugin.json`.)

- [ ] **Step 9.5: Build + verify**

```bash
cd packages/sdk-rn && pnpm build 2>&1 | tail -15
```

Expected: tsup output (ESM + CJS + d.ts) + tsc output (plugin/build/). No errors.

```bash
ls packages/sdk-rn/dist/
```

Expected: `index.js`, `index.cjs`, `index.d.ts`, `version.js`, `version.cjs`, `version.d.ts`, plus source maps.

- [ ] **Step 9.6: Verify tests still green**

```bash
cd packages/sdk-rn && pnpm test 2>&1 | tail -10
```

Expected: **50 tests passing** (unchanged by the build config).

- [ ] **Step 9.7: Verify dist/ is gitignored**

```bash
grep -E "^dist|/dist" packages/sdk-rn/.gitignore .gitignore 2>/dev/null
```

If not present, add to `packages/sdk-rn/.gitignore`:

```bash
echo "dist/" >> packages/sdk-rn/.gitignore
```

- [ ] **Step 9.8: Commit**

```bash
git add packages/sdk-rn/tsup.config.ts \
        packages/sdk-rn/package.json \
        packages/sdk-rn/tsconfig.json \
        packages/sdk-rn/.gitignore \
        pnpm-lock.yaml
git commit -m "feat(sdk-rn): TS dual format (ESM + CJS + .d.ts) via tsup"
```

---

## Task 10: Sample app — `examples/sample-rn-expo/`

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `examples/sample-rn-expo/package.json`
- Create: `examples/sample-rn-expo/app.json`
- Create: `examples/sample-rn-expo/tsconfig.json`
- Create: `examples/sample-rn-expo/metro.config.js`
- Create: `examples/sample-rn-expo/App.tsx`
- Create: `examples/sample-rn-expo/README.md`
- Create: `examples/sample-rn-expo/.gitignore`

No native build attempted in this task — parity gate runs it in Task 11.

- [ ] **Step 10.1: Add `examples/*` to `pnpm-workspace.yaml`**

Open `pnpm-workspace.yaml`. Current content:

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "scripts"
```

Update to:

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "examples/*"
  - "scripts"
```

- [ ] **Step 10.2: Create `examples/sample-rn-expo/package.json`**

```json
{
  "name": "sample-rn-expo",
  "version": "0.0.1",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "prebuild": "expo prebuild --clean",
    "prebuild:ios": "expo prebuild --platform ios --clean",
    "prebuild:android": "expo prebuild --platform android --clean",
    "ios": "expo run:ios",
    "android": "expo run:android",
    "start": "expo start --dev-client"
  },
  "dependencies": {
    "@rovenue/react-native-sdk": "workspace:*",
    "expo": "~51.0.0",
    "expo-dev-client": "~4.0.0",
    "expo-modules-core": "~1.12.0",
    "expo-router": "~3.5.0",
    "react": "18.2.0",
    "react-native": "0.74.0"
  },
  "devDependencies": {
    "@babel/core": "^7.24.0",
    "@types/react": "~18.2.45",
    "typescript": "~5.3.0"
  }
}
```

NOTE: pins reflect the Expo 51 / RN 0.74 baseline from the spec. If Expo 51 isn't the latest at execution time, bump the trio (`expo`, `react`, `react-native`) together — never independently.

- [ ] **Step 10.3: Create `examples/sample-rn-expo/app.json`**

```json
{
  "expo": {
    "name": "sample-rn-expo",
    "slug": "sample-rn-expo",
    "version": "0.0.1",
    "ios": {
      "bundleIdentifier": "dev.rovenue.sample"
    },
    "android": {
      "package": "dev.rovenue.sample"
    },
    "plugins": ["@rovenue/react-native-sdk"]
  }
}
```

- [ ] **Step 10.4: Create `examples/sample-rn-expo/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2020",
    "module": "esnext",
    "moduleResolution": "node",
    "jsx": "react-jsx",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true
  },
  "include": ["App.tsx", "**/*.ts", "**/*.tsx"]
}
```

- [ ] **Step 10.5: Create `examples/sample-rn-expo/metro.config.js`**

```js
// Monorepo-aware Metro config: watch the workspace root and resolve
// node_modules from both the project and workspace level.

const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "../..");
const projectRoot = __dirname;

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
```

- [ ] **Step 10.6: Create `examples/sample-rn-expo/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { SafeAreaView, Text, View } from "react-native";
import { Rovenue, useCurrentUser } from "@rovenue/react-native-sdk";

export default function App() {
  const [version, setVersion] = useState<string | null>(null);
  const user = useCurrentUser();

  useEffect(() => {
    Rovenue.configure({
      apiKey: "pk_smoke_test",
      baseUrl: "https://api.rovenue.dev",
      debug: true,
    });
    setVersion(Rovenue.getVersion());
    Rovenue.setLogHandler((entry) => {
      console.log(`[rovenue:${entry.level}]`, entry.message, entry.data ?? "");
    });
  }, []);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ padding: 24, gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: "600" }}>Rovenue SDK smoke</Text>
        <Text>SDK version: {version ?? "—"}</Text>
        <Text>anonId: {user?.anonId ?? "loading…"}</Text>
        <Text>knownUserId: {user?.knownUserId ?? "(not identified)"}</Text>
      </View>
    </SafeAreaView>
  );
}
```

- [ ] **Step 10.7: Create `examples/sample-rn-expo/README.md`**

```markdown
# sample-rn-expo

Minimal Expo dev client app for smoke-testing `@rovenue/react-native-sdk`.

Renders SDK version + anonymous user ID; logs bridge events via
`Rovenue.setLogHandler`.

## Run locally

```bash
pnpm install                           # from repo root
cd examples/sample-rn-expo

# Generate native ios/ + android/ projects from the Expo config
pnpm prebuild

# iOS (requires Xcode + a connected sim/device)
pnpm ios

# Android (requires Android SDK + JDK 17 + an emulator/device)
pnpm android
```

## Why not Expo Go?

Expo Go cannot load native modules like `@rovenue/react-native-sdk`.
Use the dev client (`expo-dev-client`) — `pnpm prebuild` + `pnpm ios` /
`pnpm android` produces a custom dev client with the Rovenue native
bridge linked in.

## Config plugin

`app.json` declares `"plugins": ["@rovenue/react-native-sdk"]`. At
prebuild time, the plugin patches `ios/Podfile` to add `pod 'Rovenue',
:path => '../../../packages/sdk-swift'` and patches Android's
`settings.gradle.kts` + `app/build.gradle` to add
`includeBuild("../../../packages/sdk-kotlin")` and
`implementation("dev.rovenue:sdk:0.1.0")`.
```

- [ ] **Step 10.8: Create `examples/sample-rn-expo/.gitignore`**

```
node_modules/
ios/
android/
.expo/
dist/
*.log
```

NOTE: `ios/` and `android/` are gitignored because they're regenerated by `expo prebuild`. The source of truth is `app.json` + the config plugin.

- [ ] **Step 10.9: Workspace install — verify symlink**

```bash
pnpm install 2>&1 | tail -10
```

Expected: workspace links resolve. Sample app's `node_modules/@rovenue/react-native-sdk` should be a symlink:

```bash
ls -la examples/sample-rn-expo/node_modules/@rovenue/react-native-sdk 2>&1 | head -3
```

Expected: arrow pointing to `../../../../packages/sdk-rn` (or similar).

If `examples/sample-rn-expo/node_modules` doesn't exist, the workspace glob didn't catch it — recheck `pnpm-workspace.yaml`.

- [ ] **Step 10.10: Commit**

```bash
git add pnpm-workspace.yaml \
        examples/sample-rn-expo/ \
        pnpm-lock.yaml
git commit -m "feat(examples): sample-rn-expo smoke app for SDK distribution"
```

---

## Task 11: Parity script — RN sample native compile sections

**Files:**
- Modify: `scripts/sdk-parity.sh`

Append RN sample native compile sections after the existing RN vitest section. Best-effort: skip cleanly when Xcode / Android SDK unavailable.

- [ ] **Step 11.1: Read existing script to find insertion point**

```bash
grep -n "RN stub tests passed\|^echo\\$" scripts/sdk-parity.sh
```

Identify the line `echo "  ✓ RN stub tests passed"` and the blank `echo` before the final parity-summary line.

- [ ] **Step 11.2: Append the native compile sections**

Edit `scripts/sdk-parity.sh`. Locate the block:

```bash
echo "→ RN test"
pnpm --filter @rovenue/react-native-sdk test 2>&1 | tee /tmp/rovenue-rn-parity.log >/dev/null
grep -E "Test Files +1 passed|[0-9]+ passed" /tmp/rovenue-rn-parity.log >/dev/null
echo "  ✓ RN stub tests passed"

echo
echo "✓ Parity: all available codepaths agree on version $RUST_VER"
```

Replace with:

```bash
echo "→ RN test"
pnpm --filter @rovenue/react-native-sdk test 2>&1 | tee /tmp/rovenue-rn-parity.log >/dev/null
grep -E "Test Files +1 passed|[0-9]+ passed" /tmp/rovenue-rn-parity.log >/dev/null
echo "  ✓ RN unit tests passed"

# ---- RN sample app native compile (best-effort) ----
echo "→ RN sample app native compile"

# iOS
if command -v xcodebuild >/dev/null 2>&1 && [ -d "/Applications/Xcode.app" ]; then
  (
    set -e
    cd examples/sample-rn-expo
    pnpm install --frozen-lockfile >/dev/null 2>&1 || true
    pnpm expo prebuild --platform ios --no-install >/tmp/rovenue-sample-ios.log 2>&1
    (cd ios && pod install >>/tmp/rovenue-sample-ios.log 2>&1)
    SCHEME=$(ls ios/*.xcworkspace | head -n 1 | xargs -I {} basename {} .xcworkspace)
    xcodebuild -workspace "ios/${SCHEME}.xcworkspace" -scheme "${SCHEME}" \
      -sdk iphonesimulator -configuration Debug build \
      >>/tmp/rovenue-sample-ios.log 2>&1
  )
  echo "  ✓ iOS sample build succeeded"
else
  echo "  ~ xcodebuild unavailable — iOS sample build skipped"
fi

# Android
if command -v java >/dev/null 2>&1 && [ -n "${ANDROID_HOME:-}" ]; then
  (
    set -e
    cd examples/sample-rn-expo
    pnpm expo prebuild --platform android --no-install >/tmp/rovenue-sample-android.log 2>&1
    (cd android && ./gradlew assembleDebug >>/tmp/rovenue-sample-android.log 2>&1)
  )
  echo "  ✓ Android sample build succeeded"
else
  echo "  ~ gradle/Android SDK unavailable — Android sample build skipped"
fi

echo
echo "✓ Parity: all available codepaths agree on version $RUST_VER"
```

- [ ] **Step 11.3: Run parity (may partially skip)**

```bash
./scripts/sdk-parity.sh 2>&1 | tail -25
```

Expected progress:
- Rust core tests pass
- Swift façade tests pass (now 32; pre-M6 was 30)
- Kotlin façade tests pass (now 18; pre-M6 was 16) — or `SKIPPED (gradle not on PATH)`
- RN unit tests pass (50)
- iOS sample build — `succeeded` or `skipped`
- Android sample build — `succeeded` or `skipped`
- Final line: `✓ Parity: all available codepaths agree on version <RUST_VER>`

If any of the **non-best-effort** steps fail (Rust / Swift / RN / Kotlin-when-available), investigate and fix before committing.

If the iOS or Android sample build fails (toolchain present but build broken), capture the log and fix. The expected failure modes are:
- Plugin path mismatch (paths in `withRovenueIos.ts` / `withRovenueAndroid.ts` don't resolve from the prebuild output)
- Missing M3 / M4 references (Tasks 5 / 7 didn't actually run)
- Pod cache stale — clear via `rm -rf examples/sample-rn-expo/ios/Pods` and retry

- [ ] **Step 11.4: Commit**

```bash
git add scripts/sdk-parity.sh
git commit -m "test(sdk): parity script gates RN sample native compile (best-effort)"
```

---

## Task 12: Final sweep — rename audit + open-question docs

**Files:**
- Modify: any remaining `@rovenue/sdk-rn` references (audit)

- [ ] **Step 12.1: Audit for stale `@rovenue/sdk-rn` references**

```bash
grep -rn "@rovenue/sdk-rn" \
  --include="*.json" --include="*.yaml" --include="*.yml" \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.md" \
  --include="*.sh" --include="*.kt" --include="*.swift" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
  --exclude-dir=plugin --exclude-dir=build .
```

Expected references that SHOULD remain:
- `docs/superpowers/plans/2026-05-27-sdk-m5-rn-facade.md` — historical M5 plan, do not modify
- `docs/superpowers/specs/2026-05-27-sdk-rn-facade-design.md` — historical M5 spec, do not modify
- `docs/superpowers/specs/2026-05-27-sdk-m6-distribution-design.md` — describes the rename, do not modify

References that need updating:
- `turbo.json` (if it lists package names — see Step 12.2)
- Any internal docs / READMEs (audit)

- [ ] **Step 12.2: Check turbo.json**

```bash
cat turbo.json 2>/dev/null | grep -n "sdk-rn\|react-native-sdk" || echo "no matches"
```

If matches found, update them to `@rovenue/react-native-sdk`. Turbo's `tasks` and `pipeline` configs usually reference scripts by name, not package, so this often needs no change — verify.

- [ ] **Step 12.3: Run full parity one more time as final check**

```bash
./scripts/sdk-parity.sh 2>&1 | tail -25
```

Expected: same green output as Task 11.3.

- [ ] **Step 12.4: Summarise M6 commits**

```bash
git log --oneline main..HEAD 2>/dev/null || git log --oneline -15
```

Expected: ~10 commits prefixed `feat(sdk-rn)|feat(sdk-swift)|feat(sdk-kotlin)|chore(sdk-rn)|test(sdk)|feat(examples)`.

- [ ] **Step 12.5: Commit (only if Step 12.2 changed turbo.json)**

```bash
git status --short
```

If clean, skip. Otherwise:

```bash
git add turbo.json
git commit -m "chore(turbo): align pipeline with @rovenue/react-native-sdk rename"
```

- [ ] **Step 12.6: Hand-off**

Stop and report to controller:
1. All 12 tasks complete
2. Final test counts: Rust 36, Swift 32, Kotlin 18 (if gradle available), RN 50, Sample iOS + Android (best-effort, skipped if toolchain unavailable)
3. Ask whether to:
   - Merge to main locally (if on a feature branch)
   - Push + open PR
   - Leave the branch in the worktree for further iteration

---

## Self-Review Notes

**Spec coverage** (skimming each spec section against tasks):

- **Goals** — every bullet has an implementing task:
  - Buildable end-to-end → Task 11 (parity gate runs the sample build)
  - Replace Nitro with Expo Modules → Task 1 (JS-side), Tasks 3+4 (native bridges)
  - Config plugin handles SPM + Gradle composite build → Task 8
  - Minimal smoke sample app → Task 10
  - TS dual format via tsup → Task 9
  - `Rovenue.setLogHandler(fn)` JS log seam → Task 2 (JS), Task 5 (Swift), Task 7 (Kotlin)
  - Parity gate native compile → Task 11
  - Rename @rovenue/sdk-rn → @rovenue/react-native-sdk + v0.1.0 → Task 1 (npm name + version), Task 12 (final audit)

- **Non-goals** — verified absent: no Maven Central publish task, no CocoaPods Trunk push, no external-consumer plugin path (M6 hard-codes monorepo paths), no StoreKit/BillingClient, no Expo Go support, no Rust tracing → JS forwarding, no directory rename.

- **Architectural decisions table** — every row has implementing tasks:
  - Native binding framework (Expo Modules) → Tasks 1, 3, 4
  - iOS link strategy (Podfile :path) → Tasks 6 (M3 podspec), 8 (plugin iOS mod), 10 (sample app.json)
  - Android link strategy (composite build) → Tasks 7 (M4 group/version), 8 (plugin Android mod), 10 (sample)
  - Config plugin entry (app.plugin.js) → Task 8
  - Sample app → Task 10
  - TS module format (tsup) → Task 9
  - Test approach (existing 48 stay green + new) → Tasks 1, 2, 5, 7
  - Parity script integration → Task 11
  - setLogHandler scope (bridge-level emit) → Tasks 2, 5, 7
  - Package name + version → Task 1

- **File Structure section** — every deleted, modified, and new file is owned by a numbered task in the "Files" header of that task.

- **Native bridge surface code blocks** — Swift bridge in Task 3 (line-by-line match with spec), Kotlin bridge in Task 4 (line-by-line match with spec), JS native.ts in Task 1.

- **Config plugin design** — Tasks 6, 7, 8 split the spec's three sub-sections (M3 podspec, M4 Gradle coords, plugin mods).

- **Sample app section** — Task 10 creates every file the spec lists.

- **setLogHandler section** — JS API in Task 2, Swift impl in Task 5 (LogEntry + extension + emit calls + privacy contract + handler lifetime via static dict), Kotlin impl in Task 7 (mirrors Swift).

- **TS dual format section** — Task 9.

- **Parity script integration section** — Task 11.

- **Testing strategy** — covered by per-task TDD steps. Final counts table in this plan's "Reality-check notes" matches the spec.

- **Migration & Compatibility** — the rename impact table is implemented by Task 1 (package.json), Task 11 (parity script), Task 12 (turbo.json + final audit). Breaking changes section confirms no real consumers — no migration script needed.

- **Open Questions / Deferred** — explicitly NOT in scope; reflected in this plan's Non-Goals.

**Placeholder scan:** no TBDs. The phrase "M7" appears only as scope-delineation (deferring future work), not as placeholders.

**Type consistency check:**

- `LogEntry` is the type name used uniformly: JS (`packages/sdk-rn/src/api/log.ts`), Swift (`packages/sdk-swift/Sources/Rovenue/Rovenue.swift`), Kotlin (`packages/sdk-kotlin/.../Rovenue.kt`). Re-exported from `packages/sdk-rn/src/index.ts`.
- `RovenueModuleSpec` is the interface name in TS (`specs/RovenueModule.types.ts`), referenced by `core/native.ts`, `_mockNative.ts`, and `_stubExpoModules.ts`.
- Event names use SCREAMING_SNAKE_CASE strings: `"IDENTITY_CHANGED"`, `"ENTITLEMENTS_CHANGED"`, `"CREDIT_BALANCE_CHANGED"`. Consistent across:
  - Swift `eventName(_:)` switch (Task 3, spec)
  - Kotlin `event.name` (Task 4, spec — enum constant names match)
  - eventBridge `payload.event` switch (Task 1)
  - Mock `__emit(event)` callers in existing M5 tests (kept compatible)
- Expo event channel names: `"onChange"`, `"onLog"`. Consistent in Swift bridge, Kotlin bridge, mock stub, eventBridge, log.ts.
- `setLogHandler(fn)` signature: takes a `(LogEntry) => void` or `null`; returns `void`. JS api matches Rovenue namespace export.
- Composite build coordinates: `dev.rovenue:sdk:0.1.0`. Used in Task 7 (M4 build.gradle.kts), Task 8 (plugin/withRovenueAndroid.ts), and the spec. All three match exactly.
- iOS pod name: `'Rovenue'` for M3 façade (Task 6 podspec, Task 8 plugin), `'RovenueSdkRn'` for sdk-rn bridge (Task 3 podspec). Two distinct pods, never confused.

**Cross-task dependencies:**

- Task 1 (JS framework swap) — independent base. Must finish first; everything else depends on the renamed package.
- Task 2 (setLogHandler JS) — depends on Task 1 (`core/native.ts` exports `getEmitter()`).
- Task 3 (iOS Expo Module) — references `Rovenue.shared.setLogHandler` from Task 5; source-only so order can be relaxed, but logical reading order: do Task 5 before Task 11 (which actually builds).
- Task 4 (Android Expo Module) — references `Rovenue.shared.setLogHandler` from Task 7; same posture as Task 3.
- Task 5 (M3 Swift setLogHandler) — depends on existing M3 sources; independent of M6 JS work.
- Task 6 (M3 podspec) — independent file addition; no dependencies.
- Task 7 (M4 Kotlin setLogHandler + Gradle coords) — depends on existing M4 sources; independent of M6 JS work.
- Task 8 (config plugin) — depends on Task 1 (`@expo/config-plugins` devDep present), Task 6 (podspec exists), Task 7 (Gradle coords exist).
- Task 9 (tsup dual format) — depends on Task 1 (renamed package), Task 2 (final JS surface), Task 8 (`tsconfig.plugin.json` is a sibling).
- Task 10 (sample app) — depends on Task 1 (package name), Task 9 (built dist/), Task 8 (config plugin available).
- Task 11 (parity script + sample native build) — depends on everything before it.
- Task 12 (final sweep) — terminal.

**Recommended execution order:** strict numerical (1 → 12). The plan is structured so each task's prerequisites are satisfied by all preceding tasks.

**Known risks (carry forward from spec's "Open Questions"):**

- **Expo SDK version drift.** Pinned to 51 / RN 0.74. If the registry has moved on at execution time, bump the trio and verify config-plugin APIs still match.
- **`@expo/config-plugins` mod API surface.** `withSettingsGradle`, `withAppBuildGradle`, `withDangerousMod` are stable on 8.x but minor versions occasionally add new fields. If `cfg.modResults.contents` doesn't exist (renamed?), check the @expo/config-plugins docs for the current shape.
- **OnStartObserving / OnStopObserving lifecycle churn under RN Fast Refresh.** Sample app may drop events during dev mode. If observed, switch the native bridges to `OnCreate` / `OnDestroy` for `Rovenue.shared.changes` subscription instead.
- **iOS sample's `librovenue.a` static lib path.** The Rovenue.podspec's `vendored_libraries` points to `Sources/Rovenue/librovenue.a`. That file is produced by `packages/core-rs/scripts/build-bindings.sh`. If the parity script's "regenerate bindings" step (which runs first) doesn't put the lib there in M6, the iOS sample build fails. Verify the existing M0 build script output location matches.

---

*End of plan.*
