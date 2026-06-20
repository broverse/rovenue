# iOS Deterministic Deferred Recovery (Sub-project C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On iOS, recover a funnel token deterministically — app-triggered clipboard read (`claimFromClipboard`) as primary, server-side IP-only unique-match (`claimInstall`) as fallback — with no device fingerprinting.

**Architecture:** A new `claimFromClipboard()` reads a `rovenue-funnel:<token>` clipboard marker on iOS (`@MainActor` UIPasteboard) and claims via the existing `claimFunnelToken`. The iOS `claimInstall` path sends no device signals; the backend `claim-install` iOS branch matches the request IP only, granting solely when exactly one unclaimed candidate exists in a 1-hour window. The web funnel runner writes the clipboard marker on its open-app CTA.

**Tech Stack:** Swift (Expo iOS module, UIKit), Kotlin (Android no-op), TypeScript (sdk-rn Vitest; Hono backend + Zod + Drizzle; React dashboard runner).

## Global Constraints

- Stay on the current git branch (main); never switch/create branches/worktrees; commit on current HEAD.
- Conventional commits.
- **No device fingerprinting.** iOS sends no device signals; the backend matches IP-only.
- The clipboard holds the funnel **token** → primary path is `claimFunnelToken`, not `claimInstall`.
- Clipboard marker: `rovenue-funnel:<token>`. The SDK acts only on this prefix; it never reads/exposes other clipboard content, and clears its own marked content after a successful read.
- IP-only match is **unique-match-only**: grant only when exactly one unclaimed candidate from the request IP exists in the window; 0 or 2+ → 404 (prevents leaking a paying user's purchase on a shared IP).
- Deferred-claim window: **1 hour** (was 24h).
- **Verification reality:** `packages/sdk-rn/ios` has NO standalone compile path (UIPasteboard needs an iOS runtime), so the iOS native code (Task 2) is **review-verified + real-app integration only**. The backend (Task 1), RN TS (Task 3), and web (Task 4) ARE fully testable.

---

### Task 1: Backend — IP-only unique-match + schema relax + 1h window

**Files:**
- Create: `apps/api/src/services/funnel/deferred-match.ts`
- Test: `apps/api/src/services/funnel/deferred-match.test.ts`
- Modify: `apps/api/src/routes/v1/funnel-claim.ts` (schema + iOS branch + import)
- Modify: `apps/api/src/routes/public/funnel-universal.ts` (TTL)

**Interfaces:**
- Consumes: `funnelDeferredClaimRepo.findRecentByIpHash` (ipHash + unexpired + unmatched), `hashIp`, `readIp`, `generateClaimToken`, `hashToken`, `funnelClaimTokenRepo.rotateHash`, `funnelDeferredClaimRepo.markMatched`.
- Produces: `selectUniqueCandidate<T>(candidates: T[]): T | null` — the unique-match decision (consumed by the iOS claim-install branch).

- [ ] **Step 1: Write the failing test (pure unique-match decision)**

Create `apps/api/src/services/funnel/deferred-match.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { selectUniqueCandidate } from "./deferred-match";

describe("selectUniqueCandidate", () => {
  it("returns the single candidate when exactly one", () => {
    expect(selectUniqueCandidate([{ id: "a" }])).toEqual({ id: "a" });
  });
  it("returns null when no candidates (no match)", () => {
    expect(selectUniqueCandidate([])).toBeNull();
  });
  it("returns null when 2+ candidates (ambiguous — shared IP, do not leak)", () => {
    expect(selectUniqueCandidate([{ id: "a" }, { id: "b" }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/services/funnel/deferred-match.test.ts`
Expected: FAIL — `Cannot find module './deferred-match'`.

- [ ] **Step 3: Implement the pure decision**

Create `apps/api/src/services/funnel/deferred-match.ts`:

```typescript
/**
 * IP-only deferred-claim match decision. The backend recovers an iOS funnel
 * token only when exactly ONE unclaimed deferred-claim row exists for the
 * request IP within the window. Zero means no match; two or more means a
 * shared IP (NAT/CGNAT) where granting could leak one user's purchase to
 * another — so we deliberately decline rather than guess.
 */
export function selectUniqueCandidate<T>(candidates: T[]): T | null {
  return candidates.length === 1 ? candidates[0] : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/services/funnel/deferred-match.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Relax the claim-install schema**

In `apps/api/src/routes/v1/funnel-claim.ts`, change `claimInstallBody` (lines 56-64) so the iOS empty device fields are accepted (drop `locale`/`timezone` min-length, drop `screen_dims` regex, make all three optional):

```typescript
const claimInstallBody = z.object({
  platform: z.enum(["ios", "android"]),
  locale: z.string().max(16).optional(),
  timezone: z.string().max(64).optional(),
  screen_dims: z.string().max(16).optional(),
  device_model: z.string().max(64).optional(),
  install_referrer: z.string().max(2048).optional(),
  install_id: z.string().min(1).max(128),
});
```

- [ ] **Step 6: Rewrite the iOS branch to IP-only unique-match**

In `apps/api/src/routes/v1/funnel-claim.ts`, add `hashIp` and `selectUniqueCandidate` to the imports (alongside the existing `normalizeFingerprint`/`fingerprintsMatch` import from `../../services/funnel/fingerprint` and a new import for deferred-match):

```typescript
import { hashIp } from "../../services/funnel/fingerprint";
import { selectUniqueCandidate } from "../../services/funnel/deferred-match";
```

Replace the entire `if (body.platform === "ios") { ... }` block (lines 257-307 — the `normalizeFingerprint` + `for (const cand of candidates) { fingerprintsMatch ... }` loop) with:

```typescript
      // -- iOS: deterministic IP-only unique-match (no device fingerprinting).
      // We match the request IP against unclaimed deferred rows in the window
      // and grant ONLY when exactly one exists (shared IP → decline).
      if (body.platform === "ios") {
        const ipHash = hashIp(readIp(c));
        const candidates =
          await drizzle.funnelDeferredClaimRepo.findRecentByIpHash(
            drizzle.db,
            ipHash,
            new Date(),
          );
        const cand = selectUniqueCandidate(candidates);
        if (!cand) return c.json({ data: null }, 404);

        // Rotate the token hash so the universal-link plaintext can never be
        // replayed; return the fresh plaintext exactly once to this install.
        const fresh = generateClaimToken();
        await drizzle.funnelClaimTokenRepo.rotateHash(
          drizzle.db,
          cand.tokenId,
          hashToken(fresh),
        );
        await drizzle.funnelDeferredClaimRepo.markMatched(
          drizzle.db,
          cand.id,
          body.install_id,
        );
        return c.json({ data: { token: fresh } });
      }
```

If this leaves `normalizeFingerprint`, `NormalizedFingerprint`, or `fingerprintsMatch` imported-but-unused in this file, remove them from the import (they remain defined in `fingerprint.ts` for the click-time write). Run `cd apps/api && pnpm tsc --noEmit` (or the project's typecheck) to catch unused-import / type errors.

- [ ] **Step 7: Shorten the deferred-claim window to 1h**

In `apps/api/src/routes/public/funnel-universal.ts`, change the TTL constant (line ~49):

```typescript
const DEFERRED_TTL_MS = 1 * 60 * 60 * 1000; // 1h window (was 24h) — IP-only match
```

- [ ] **Step 8: Verify**

Run: `cd apps/api && pnpm vitest run src/services/funnel/deferred-match.test.ts && pnpm tsc --noEmit`
Expected: deferred-match tests PASS; typecheck clean (no unused imports, the iOS branch + schema compile). Note: a full DB-backed route test needs the integration harness; the unique-match decision (the security-critical rule) is unit-covered here.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/funnel/deferred-match.ts apps/api/src/services/funnel/deferred-match.test.ts \
        apps/api/src/routes/v1/funnel-claim.ts apps/api/src/routes/public/funnel-universal.ts
git commit -m "feat(api): iOS claim-install IP-only unique-match + 1h window (no fingerprinting)"
```

---

### Task 2: iOS native — `claimFromClipboard` + iOS `claimInstall` platform default

**Files:**
- Modify: `packages/sdk-rn/ios/RovenueModule.swift`
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`

**Interfaces:**
- Consumes: `Rovenue.shared.claimFunnelToken(_:)` (façade, from A); existing `claimInstall` AsyncFunction.
- Produces: the JS-callable `claimFromClipboard` (iOS reads the marker → claim; Android no-op → null) and an iOS `claimInstall` that defaults `platform` to `"ios"`.

**Verification:** review-only (no standalone iOS compile; UIPasteboard needs an iOS runtime). Real verification = consuming Expo app on a device.

- [ ] **Step 1: Add `import UIKit`**

In `packages/sdk-rn/ios/RovenueModule.swift`, add to the imports (after `import ExpoModulesCore` / `import Rovenue`):

```swift
import UIKit
```

- [ ] **Step 2: Default the iOS `claimInstall` platform to "ios"**

In `RovenueModule.swift`, in the existing `AsyncFunction("claimInstall")` block (lines ~214-225), change the platform line so an argument-less `claimInstall()` correctly takes the backend iOS branch:

```swift
        platform: params["platform"] as? String ?? "ios",
```

(Leave the other fields as `?? ""` / `as? String?` — iOS sends empty device fields; the backend now accepts them and matches IP-only.)

- [ ] **Step 3: Add the `claimFromClipboard` AsyncFunction**

In `RovenueModule.swift`, add near `claimFunnelToken` (around line 210):

```swift
        AsyncFunction("claimFromClipboard") { () -> [String: Any?]? in
            let marker = "rovenue-funnel:"
            let raw: String? = await MainActor.run { UIPasteboard.general.string }
            guard let s = raw, s.hasPrefix(marker) else { return nil }
            let token = String(s.dropFirst(marker.count))
            guard !token.isEmpty else { return nil }
            let r = try await Rovenue.shared.claimFunnelToken(token)
            // Clear only our own marked content so it isn't re-claimed/leaked.
            await MainActor.run {
                if UIPasteboard.general.string?.hasPrefix(marker) == true {
                    UIPasteboard.general.string = ""
                }
            }
            return ["subscriberId": r.subscriberId, "funnelAnswersJson": r.funnelAnswersJson]
        }
```

- [ ] **Step 4: Add the Android no-op**

In `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`, add near `claimFunnelToken`:

```kotlin
        AsyncFunction("claimFromClipboard") Coroutine { ->
            // Android's deferred path is the Play Install Referrer (sub-project B);
            // clipboard recovery is iOS-only. No-op for API symmetry.
            null
        }
```

- [ ] **Step 5: Static self-check**

There is no standalone compile for either Expo module. Re-read the changes: `UIPasteboard.general.string` is a `String?`; `await MainActor.run { ... }` returns the closure value; `Rovenue.shared.claimFunnelToken` is `async throws -> FunnelClaimResult` with `.subscriberId`/`.funnelAnswersJson`. Confirm the Android `claimFromClipboard` returns `null` with the `Coroutine { -> ... }` shape used by other no-arg coroutine functions. Report that compile/runtime verification requires a consuming Expo app build.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-rn/ios/RovenueModule.swift \
        packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt
git commit -m "feat(sdk-rn): claimFromClipboard (iOS NativeLink) + iOS claimInstall platform default"
```

---

### Task 3: RN TS — `claimFromClipboard` public API

**Files:**
- Modify: `packages/sdk-rn/src/api/funnel.ts`
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts`
- Modify: `packages/sdk-rn/src/index.ts`
- Test: `packages/sdk-rn/src/api/funnel.test.ts`

**Interfaces:**
- Consumes: `getNative().claimFromClipboard`, `call()`, `parse()` (from A).
- Produces: `Rovenue.claimFromClipboard(): Promise<FunnelClaimResult | null>`.

- [ ] **Step 1: Write the failing test**

In `packages/sdk-rn/src/api/funnel.test.ts`, add the mock fn to the `vi.mock("../core/native", ...)` factory's `getNative` (next to `claimFunnelToken` etc.): `claimFromClipboard`. Then add:

```typescript
  it("claimFromClipboard parses a native result", async () => {
    claimFromClipboard.mockResolvedValue({ subscriberId: "s", funnelAnswersJson: '{"q":1}' });
    expect(await cfc()).toEqual({ subscriberId: "s", funnelAnswers: { q: 1 } });
  });
  it("claimFromClipboard returns null when native returns null", async () => {
    claimFromClipboard.mockResolvedValue(null);
    expect(await cfc()).toBeNull();
  });
```

Add `const claimFromClipboard = vi.fn();` near the other mock fns, add it to the mock factory's `getNative()` return, and `import { claimFromClipboard as cfc } from "./funnel";`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test`
Expected: FAIL — `cfc is not a function` / no export `claimFromClipboard`.

- [ ] **Step 3: Add the wrapper**

In `packages/sdk-rn/src/api/funnel.ts`, add (mirroring `claimInstall`'s null handling + `parse`):

```typescript
/** iOS only: read a `rovenue-funnel:` clipboard marker (after a user gesture)
 *  and claim it. Resolves null on Android, or when no marker is present. */
export async function claimFromClipboard(): Promise<FunnelClaimResult | null> {
  return call(async () => {
    const n = (await getNative().claimFromClipboard()) as NativeClaim | null;
    return n ? parse(n) : null;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test`
Expected: PASS.

- [ ] **Step 5: Wire the spec + public surface**

In `packages/sdk-rn/src/specs/RovenueModule.types.ts`, add to `RovenueModuleSpec` (near the other funnel methods):

```typescript
  claimFromClipboard(): Promise<{ subscriberId: string; funnelAnswersJson: string } | null>;
```

In `packages/sdk-rn/src/index.ts`, add the import (next to the other `./api/funnel` imports) and add `claimFromClipboard` to the `Rovenue` object:

```typescript
import { claimFunnelToken, claimInstall, claimViaEmail, installId, addFunnelClaimListener, claimFromClipboard } from "./api/funnel";
```
```typescript
  claimFromClipboard,
```

(If `_mockNative.ts` enumerates the spec and needs a stub, add `claimFromClipboard: vi.fn(async () => null)` — note it in the commit.)

- [ ] **Step 6: Typecheck + full suite**

Run: `cd packages/sdk-rn && pnpm build && pnpm test`
Expected: tsc=0 and all tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-rn/src/api/funnel.ts packages/sdk-rn/src/api/funnel.test.ts \
        packages/sdk-rn/src/specs/RovenueModule.types.ts packages/sdk-rn/src/index.ts \
        packages/sdk-rn/src/__tests__/_mockNative.ts
git commit -m "feat(sdk-rn): add Rovenue.claimFromClipboard() public API"
```

---

### Task 4: Web — funnel runner writes the clipboard marker

**Files:**
- Create: `apps/dashboard/src/runner/clipboard.ts`
- Test: `apps/dashboard/src/runner/clipboard.test.ts`
- Modify: `apps/dashboard/src/runner/funnel-runner.tsx`

**Interfaces:**
- Consumes: `claimToken(sessionId)` → `{ token, ... }` (existing, runner-api.ts).
- Produces: `writeFunnelTokenToClipboard(token: string): Promise<void>` (best-effort, swallows rejection).

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/runner/clipboard.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFunnelTokenToClipboard } from "./clipboard";

describe("writeFunnelTokenToClipboard", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("writes the rovenue-funnel marker", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await writeFunnelTokenToClipboard("abc123");
    expect(writeText).toHaveBeenCalledWith("rovenue-funnel:abc123");
  });

  it("swallows a rejected clipboard write", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(writeFunnelTokenToClipboard("abc123")).resolves.toBeUndefined();
  });

  it("no-ops when clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(writeFunnelTokenToClipboard("abc123")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/dashboard && pnpm vitest run src/runner/clipboard.test.ts`
Expected: FAIL — `Cannot find module './clipboard'`.

- [ ] **Step 3: Implement the helper**

Create `apps/dashboard/src/runner/clipboard.ts`:

```typescript
/**
 * Writes the funnel token to the clipboard as `rovenue-funnel:<token>` so the
 * iOS app can recover it on first launch (NativeLink-style deferred deep link).
 * Best-effort: clipboard writes can reject (permission / insecure context) — we
 * swallow the error because the user can still recover via deep link or email.
 * Must be called from a user-gesture handler (the open-app CTA).
 */
export async function writeFunnelTokenToClipboard(token: string): Promise<void> {
  try {
    await navigator?.clipboard?.writeText(`rovenue-funnel:${token}`);
  } catch {
    // ignore — deferred recovery degrades to deep link / email
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/dashboard && pnpm vitest run src/runner/clipboard.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Call it from the runner's claim flow**

In `apps/dashboard/src/runner/funnel-runner.tsx`, after `claimToken(state.sessionId)` resolves (around line 100, where the token is obtained), write the marker. Import the helper and call it with the returned token:

```typescript
import { writeFunnelTokenToClipboard } from "./clipboard";
// …after: const res = await claimToken(state.sessionId);
await writeFunnelTokenToClipboard(res.token);
```

Match the actual variable name the runner uses for the `claimToken` response. This runs inside the existing CTA/paywall handler (a user-gesture context), satisfying the clipboard-write gesture requirement. Keep the existing dev-stub behavior intact.

- [ ] **Step 6: Typecheck the dashboard**

Run: `cd apps/dashboard && pnpm tsc --noEmit` (or the project's typecheck)
Expected: clean — the helper import + call type-check.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/runner/clipboard.ts apps/dashboard/src/runner/clipboard.test.ts \
        apps/dashboard/src/runner/funnel-runner.tsx
git commit -m "feat(dashboard): funnel runner writes rovenue-funnel clipboard marker for iOS recovery"
```

---

### Task 5: Version bump + docs

**Files:**
- Modify: `Cargo.toml`, `packages/sdk-rn/src/version.ts`, `packages/sdk-rn/package.json` (lockstep)
- Modify: `apps/docs/content/docs/reference/methods.mdx`

- [ ] **Step 1: Bump all three versions in lockstep**

Confirm all three are equal (e.g. `0.11.0`), then bump each by one minor to the next (e.g. `0.12.0`): workspace `Cargo.toml` `[workspace.package]` version, `packages/sdk-rn/src/version.ts` `SDK_VERSION`, `packages/sdk-rn/package.json` `version`. All three MUST end identical.

- [ ] **Step 2: Document `claimFromClipboard`**

In `apps/docs/content/docs/reference/methods.mdx`, in the `## Funnel Attribution` section, add a `### claimFromClipboard` entry mirroring the existing format:
- iOS-only deterministic clipboard recovery; reads a `rovenue-funnel:<token>` marker the web funnel placed on the clipboard, then claims it.
- Returns `FunnelClaimResult | null` (null on Android, or when no marker is present).
- **Call from a user-gesture handler** (e.g. a "Continue" tap) — iOS shows a one-time paste banner on the read.
- RN example: `const result = await Rovenue.claimFromClipboard();`
Also update the `claimInstall` section's note: on iOS, recovery falls back to a deterministic server-side **IP match within 1 hour** (no device fingerprinting). Keep the deterministic/no-fingerprinting framing; do not reintroduce "probabilistic".

- [ ] **Step 3: Verify**

Run: `cargo build -p librovenue && cd packages/sdk-rn && pnpm test`
Expected: crate builds at the new version; sdk-rn tests pass including `version.test.ts` parity at the new version. `pnpm --filter @rovenue/docs build` may fail only on the known pre-existing SSR home-page crash — confirm it's that, not your MDX.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock packages/sdk-rn/src/version.ts packages/sdk-rn/package.json apps/docs/content/docs/reference/methods.mdx
git commit -m "chore(sdk): bump versions + document claimFromClipboard + iOS IP-match"
```

---

## Self-Review

**Spec coverage:**
- §5.1 `claimFromClipboard` iOS (marker, read-then-clear) + Android no-op → Task 2 + Task 3 (TS surface).
- §5.2 iOS `claimInstall` platform default + backend IP-only unique-match + schema relax + 1h TTL → Task 2 Step 2 (platform default) + Task 1.
- §5.3 web clipboard write → Task 4.
- §6 testing: backend unit (selectUniqueCandidate) + TS Vitest + web Vitest fully covered; iOS native review-only (stated). §7 versioning → Task 5.
- Decisions §3: app-triggered (Task 2/3), marked prefix + clear (Task 2 Step 3 / Task 4), IP-only unique + 1h (Task 1).

**Placeholder scan:** No TBD/TODO. Each code step shows complete code. Two adapt-to-real-file notes (Task 2 no-compile static check; Task 4 Step 5 variable name) are explicit about what to match.

**Type consistency:** `claimFromClipboard(): Promise<FunnelClaimResult | null>` (TS) ↔ native `Promise<{subscriberId, funnelAnswersJson} | null>` ↔ Swift `[String: Any?]?` / Kotlin `null`. `selectUniqueCandidate<T>(T[]) → T | null` used by the iOS branch. Clipboard marker `rovenue-funnel:<token>` identical in the iOS reader (Task 2) and the web writer (Task 4). The iOS `claimInstall` platform default `"ios"` matches the backend's `z.enum(["ios","android"])` branch check.
