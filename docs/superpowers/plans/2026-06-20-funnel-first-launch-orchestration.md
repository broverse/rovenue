# First-launch Orchestration (Sub-project E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Rovenue.resolveFunnelClaim({ url? })` runs the no-gesture deterministic funnel-recovery chain (deep link → platform deferred match) once per install and returns the claim or null.

**Architecture:** A TS orchestrator in `funnel.ts` composes the existing `claimFromUrl` + `claimInstall` (which auto-fills referrer/IP-match natively, so E is platform-agnostic), guarded by a new core `hasResolvedFunnelClaim()` accessor that reads the persisted `funnel_claim_state` from A. Gesture fallbacks (clipboard, email) stay app-driven.

**Tech Stack:** Rust (core-rs accessor, mockito), uniffi, Swift + Kotlin façade/Expo bridges, TypeScript (sdk-rn, Vitest).

## Global Constraints

- Stay on the current git branch (main); never switch/create branches/worktrees; commit on current HEAD.
- Conventional commits.
- The new accessor mirrors the existing sync `install_id()` at every layer (Rust/udl/Swift/Kotlin/RN spec). Non-throwing.
- `resolveFunnelClaim` swallows internal claim errors (treats them as "unresolved") — a recognized-but-invalid deep-link token (`claimFromUrl` throws) must NOT abort the chain; it falls through to `claimInstall`.
- Once-per-install: only a prior **`claimed`** state skips the chain; `failed`/absent re-runs.
- `resolveFunnelClaim` does NOT fire the resolution callback — the building blocks already fire `onFunnelClaimResolved` on success.
- ⚠️ `cargo test` full-compile is broken by a pre-existing unrelated `tests/events_envelope.rs` error — run Rust tests with `cargo test -p librovenue --lib`.
- uniffi Swift binding is gitignored; the Kotlin binding `librovenue.kt` is tracked-and-committed — regenerate with `npm run sdk:bindings`, commit the Kotlin diff, not the Swift one.
- `packages/sdk-rn/ios` + `android` Expo modules have NO standalone compile gate — the native AsyncFunction additions (Task 3) are review-verified.

---

### Task 1: Rust core `has_resolved_funnel_claim()` accessor

**Files:**
- Modify: `packages/core-rs/src/api.rs`
- Test: `packages/core-rs/src/api.rs` (tests module)

**Interfaces:**
- Consumes: `self.install_id()`, `FunnelRepo::new(&self.store).claim_state(install_id)` (from A).
- Produces: `RovenueCore::has_resolved_funnel_claim(&self) -> bool` — consumed by Task 2 (udl).

- [ ] **Step 1: Write the failing tests**

In `packages/core-rs/src/api.rs`, inside `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    #[serial_test::serial]
    fn has_resolved_funnel_claim_false_on_fresh_install() {
        let core = make_core("http://127.0.0.1:1");
        assert!(!core.has_resolved_funnel_claim());
    }

    #[test]
    #[serial_test::serial]
    fn has_resolved_funnel_claim_true_after_successful_claim() {
        let mut server = mockito::Server::new();
        let _m_claim = server
            .mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriber_id":"sub_1","entitlements":[],"funnel_answers":{}}}"#)
            .create();
        let _m_ent = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .expect_at_least(1)
            .create();

        let core = make_core(&server.url());
        assert!(!core.has_resolved_funnel_claim());
        core.claim_funnel_token("a_token_value".into()).expect("claim ok");
        assert!(core.has_resolved_funnel_claim(), "claimed state → resolved");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p librovenue --lib has_resolved_funnel_claim`
Expected: FAIL — `no method named has_resolved_funnel_claim`.

- [ ] **Step 3: Implement the accessor**

In `packages/core-rs/src/api.rs`, in `impl RovenueCore`, add right after `install_id()` (around line 436-440):

```rust
    /// True iff this install has already successfully claimed a funnel token
    /// (funnel_claim_state == "claimed"). Used by the SDK's first-launch
    /// orchestration to run the resolution chain at most once per install.
    pub fn has_resolved_funnel_claim(&self) -> bool {
        let install_id = self.install_id();
        FunnelRepo::new(&self.store)
            .claim_state(&install_id)
            .ok()
            .flatten()
            .as_deref()
            == Some("claimed")
    }
```

(`FunnelRepo` is already imported in api.rs; `self.store` and `claim_state` exist from A.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p librovenue --lib has_resolved_funnel_claim`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/api.rs
git commit -m "feat(core-rs): add has_resolved_funnel_claim accessor (once-per-install)"
```

---

### Task 2: Export `has_resolved_funnel_claim` over uniffi + regenerate bindings

**Files:**
- Modify: `packages/core-rs/src/librovenue.udl`

**Interfaces:**
- Consumes: `RovenueCore::has_resolved_funnel_claim` (Task 1).
- Produces: generated Swift `hasResolvedFunnelClaim() -> Bool` / Kotlin `hasResolvedFunnelClaim(): Boolean` — consumed by Task 3.

- [ ] **Step 1: Add the method to the udl**

In `packages/core-rs/src/librovenue.udl`, inside `interface RovenueCore { ... }`, add right after `string install_id();` (line ~214):

```
    boolean has_resolved_funnel_claim();
```

- [ ] **Step 2: Build + regenerate bindings**

Run: `cargo build -p librovenue`
Expected: PASS (scaffolding binds the method).

Run: `npm run sdk:bindings`
Expected: PASS — generated Swift + the tracked Kotlin binding expose `hasResolvedFunnelClaim`.

- [ ] **Step 3: Commit (udl + tracked Kotlin binding only)**

```bash
git add packages/core-rs/src/librovenue.udl packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt
git status --porcelain   # confirm no sdk-swift Generated/ files staged
git commit -m "feat(core-rs): export has_resolved_funnel_claim over uniffi"
```

---

### Task 3: Swift + Kotlin façade + Expo bridges

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Modify: `packages/sdk-rn/ios/RovenueModule.swift`
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`

**Interfaces:**
- Consumes: generated `core.hasResolvedFunnelClaim()` (Task 2).
- Produces: the JS-callable `hasResolvedFunnelClaim` native function — consumed by Task 4.

**Verification:** Kotlin via `testDebugUnitTest`; Swift façade via `swift build`; the Expo module additions are review-only (no standalone compile). Each addition is a one-line mirror of the existing `installId`.

- [ ] **Step 1: Swift façade**

In `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`, add right after `installId()` (around line 704-706):

```swift
    public func hasResolvedFunnelClaim() -> Bool {
        core.hasResolvedFunnelClaim()
    }
```

- [ ] **Step 2: Swift Expo module**

In `packages/sdk-rn/ios/RovenueModule.swift`, add next to `AsyncFunction("installId")` (around line 208):

```swift
        AsyncFunction("hasResolvedFunnelClaim") { () -> Bool in
            Rovenue.shared.hasResolvedFunnelClaim()
        }
```

- [ ] **Step 3: Kotlin façade**

In `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`, add right after `fun installId()` (line ~632):

```kotlin
    fun hasResolvedFunnelClaim(): Boolean = core.hasResolvedFunnelClaim()
```

- [ ] **Step 4: Kotlin Expo module**

In `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`, add next to `AsyncFunction("installId")` (around line 221):

```kotlin
        AsyncFunction("hasResolvedFunnelClaim") Coroutine { ->
            Rovenue.shared.hasResolvedFunnelClaim()
        }
```

- [ ] **Step 5: Verify**

Run: `cd packages/sdk-swift && swift build`
Expected: PASS (façade resolves `core.hasResolvedFunnelClaim()`; if the generated binding isn't present locally, run `npm run sdk:bindings` first).

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: PASS (all green). The Expo module files are review-only (note in the report).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-rn/ios/RovenueModule.swift \
        packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt \
        packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt
git commit -m "feat(sdk-swift,sdk-kotlin,sdk-rn): expose hasResolvedFunnelClaim across facades"
```

---

### Task 4: RN TS `resolveFunnelClaim` orchestrator

**Files:**
- Modify: `packages/sdk-rn/src/api/funnel.ts`
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts`
- Modify: `packages/sdk-rn/src/index.ts`
- Test: `packages/sdk-rn/src/api/funnel.test.ts`

**Interfaces:**
- Consumes: `getNative().hasResolvedFunnelClaim()` (Task 3); the in-module `claimFromUrl` + `claimInstall` (from C/D).
- Produces: `Rovenue.resolveFunnelClaim(opts?: { url?: string }) => Promise<FunnelClaimResult | null>`.

- [ ] **Step 1: Write the failing tests**

In `packages/sdk-rn/src/api/funnel.test.ts`, add a `hasResolvedFunnelClaim` mock fn to the `vi.mock("../core/native")` factory's `getNative()` return (next to `claimFunnelToken`/`claimInstall`), `import { resolveFunnelClaim } from "./funnel"`, then add:

```typescript
describe("resolveFunnelClaim", () => {
  const TOK = "c".repeat(48);
  const FUNNEL_URL = `https://d/universal/funnels/open/${TOK}`;
  beforeEach(() => {
    hasResolvedFunnelClaim.mockReset();
    claimFunnelToken.mockReset();
    claimInstall.mockReset();
  });

  it("skips the chain when already resolved", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(true);
    expect(await resolveFunnelClaim({ url: FUNNEL_URL })).toBeNull();
    expect(claimFunnelToken).not.toHaveBeenCalled();
    expect(claimInstall).not.toHaveBeenCalled();
  });

  it("returns the deep-link claim when the url resolves", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimFunnelToken.mockResolvedValue({ subscriberId: "s", funnelAnswersJson: "{}" });
    const r = await resolveFunnelClaim({ url: FUNNEL_URL });
    expect(r).toEqual({ subscriberId: "s", funnelAnswers: {} });
    expect(claimInstall).not.toHaveBeenCalled();
  });

  it("falls through to claimInstall when the deep-link token is invalid (throws)", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimFunnelToken.mockRejectedValue(Object.assign(new Error("x"), { code: "FunnelTokenExpired" }));
    claimInstall.mockResolvedValue({ subscriberId: "s2", funnelAnswersJson: "{}" });
    const r = await resolveFunnelClaim({ url: FUNNEL_URL });
    expect(r).toEqual({ subscriberId: "s2", funnelAnswers: {} });
    expect(claimInstall).toHaveBeenCalledTimes(1);
  });

  it("uses claimInstall when no url is given", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimInstall.mockResolvedValue({ subscriberId: "s3", funnelAnswersJson: "{}" });
    expect(await resolveFunnelClaim()).toEqual({ subscriberId: "s3", funnelAnswers: {} });
  });

  it("returns null when nothing resolves", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimInstall.mockResolvedValue(null);
    expect(await resolveFunnelClaim({})).toBeNull();
  });

  it("returns null (no throw) when claimInstall throws", async () => {
    hasResolvedFunnelClaim.mockResolvedValue(false);
    claimInstall.mockRejectedValue(new Error("network"));
    expect(await resolveFunnelClaim({})).toBeNull();
  });
});
```

Add `const hasResolvedFunnelClaim = vi.fn();` near the other mock fns and include it in the `vi.mock` factory's `getNative()` return.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test`
Expected: FAIL — `resolveFunnelClaim` not exported.

- [ ] **Step 3: Implement the orchestrator**

In `packages/sdk-rn/src/api/funnel.ts`, add (after `claimFromUrl`):

```typescript
/**
 * Run the no-gesture deterministic funnel-recovery chain once per install:
 *   direct deep link (opts.url) → platform deferred match (claimInstall:
 *   Android Install Referrer / iOS IP-only). Returns the claim, or null when
 *   nothing resolves — then surface the gesture fallbacks yourself
 *   (claimFromClipboard on iOS, then claimViaEmail). Resolved claims also fire
 *   the addFunnelClaimListener callback. Safe to call on every launch; it
 *   short-circuits once a claim has succeeded for this install.
 */
export async function resolveFunnelClaim(
  opts: { url?: string } = {},
): Promise<FunnelClaimResult | null> {
  if (await getNative().hasResolvedFunnelClaim()) return null;

  if (opts.url) {
    try {
      const r = await claimFromUrl(opts.url);
      if (r) return r;
    } catch {
      // recognized-but-invalid deep-link token → fall through to the next source
    }
  }

  try {
    const r = await claimInstall();
    if (r) return r;
  } catch {
    // network / transient → unresolved
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test`
Expected: PASS (6 new tests).

- [ ] **Step 5: Wire the spec + public surface**

In `packages/sdk-rn/src/specs/RovenueModule.types.ts`, add next to `installId` (line ~137):

```typescript
  hasResolvedFunnelClaim(): Promise<boolean>;
```

In `packages/sdk-rn/src/index.ts`:
- Add `resolveFunnelClaim` to the `./api/funnel` import.
- Add `resolveFunnelClaim` to the `Rovenue` object (near `claimFromUrl`).
- If `_mockNative.ts` enumerates the spec, add `hasResolvedFunnelClaim: vi.fn(async () => false)` — note it.

- [ ] **Step 6: Typecheck + full suite**

Run: `cd packages/sdk-rn && pnpm build && pnpm test`
Expected: tsc=0 and all tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-rn/src/api/funnel.ts packages/sdk-rn/src/api/funnel.test.ts \
        packages/sdk-rn/src/specs/RovenueModule.types.ts packages/sdk-rn/src/index.ts \
        packages/sdk-rn/src/__tests__/_mockNative.ts
git commit -m "feat(sdk-rn): add Rovenue.resolveFunnelClaim() first-launch orchestrator"
```

---

### Task 5: Version bump + docs

**Files:**
- Modify: `Cargo.toml`, `packages/sdk-rn/src/version.ts`, `packages/sdk-rn/package.json` (lockstep)
- Modify: `apps/docs/content/docs/reference/methods.mdx`

- [ ] **Step 1: Bump all three versions in lockstep**

Confirm all three are equal (e.g. `0.13.0`), then bump each by one minor to the next (e.g. `0.14.0`): workspace `Cargo.toml` `[workspace.package]` version, `packages/sdk-rn/src/version.ts` `SDK_VERSION`, `packages/sdk-rn/package.json` `version`. All three MUST end identical.

- [ ] **Step 2: Document `resolveFunnelClaim`**

In `apps/docs/content/docs/reference/methods.mdx`, in the `## Funnel Attribution` section, add a `### resolveFunnelClaim` entry (React-Native only, like `claimFromClipboard`/`claimFromUrl` — no Swift/Kotlin tabs):
- One call that runs the no-gesture deterministic chain (deep link → platform deferred match) once per install; returns `FunnelClaimResult | null`.
- Show the recommended first-launch flow:
  ```ts
  import * as Linking from 'expo-linking';
  const url = await Linking.getInitialURL();
  const result = await Rovenue.resolveFunnelClaim({ url: url ?? undefined });
  if (!result) {
    // iOS: show a "Continue" button, then: await Rovenue.claimFromClipboard();
    // then email: show a field, then: await Rovenue.claimViaEmail(email);
  }
  ```
- Note: it never throws (internal claim errors are treated as "unresolved"); resolved claims also arrive on `addFunnelClaimListener`. **Throws** — nothing.
- Add `resolveFunnelClaim` to the Funnel Attribution summary table (Throws column: —). Keep the deterministic / no-fingerprinting framing.

- [ ] **Step 3: Verify**

Run: `cargo build -p librovenue && cd packages/sdk-rn && pnpm test`
Expected: crate builds at the new version; sdk-rn tests pass including `version.test.ts` parity at the new version. `pnpm --filter @rovenue/docs build` may fail only on the known pre-existing SSR home-page crash — confirm it's that, not your MDX.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock packages/sdk-rn/src/version.ts packages/sdk-rn/package.json apps/docs/content/docs/reference/methods.mdx
git commit -m "chore(sdk): bump versions + document resolveFunnelClaim orchestration"
```

---

## Self-Review

**Spec coverage:**
- §5.1 Rust accessor → Task 1. §5.2 udl + façades → Tasks 2 & 3. §5.3 TS orchestrator (hasResolved skip → claimFromUrl try/catch → claimInstall try/catch → null) + spec + index → Task 4. §6 docs → Task 5. §7 testing (Rust accessor unit; TS orchestrator 6 cases; façade build) → Tasks 1/3/4. §8 versioning → Task 5.

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. The accessor is a verbatim mirror of `install_id` at each layer; the orchestrator + its 6 test cases are complete.

**Type consistency:** `has_resolved_funnel_claim(&self) -> bool` (Rust) ↔ `boolean has_resolved_funnel_claim()` (udl) ↔ `hasResolvedFunnelClaim() -> Bool` (Swift) / `: Boolean` (Kotlin) ↔ `hasResolvedFunnelClaim(): Promise<boolean>` (RN spec) ↔ `getNative().hasResolvedFunnelClaim()` (orchestrator). `resolveFunnelClaim(opts?: { url?: string }) => Promise<FunnelClaimResult | null>` consistent across funnel.ts, index.ts, tests. The orchestrator reuses `claimFromUrl`/`claimInstall` (from D/C) exactly.
