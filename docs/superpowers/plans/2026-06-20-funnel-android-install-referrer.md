# Android Install Referrer (Sub-project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Android, the SDK natively reads the Play Install Referrer + device context and auto-fills `claimInstall`, so the host app calls `Rovenue.claimInstall()` with no arguments.

**Architecture:** All native collection lives in the Expo Android module (`RovenueModule.kt`), which already holds the Android `Context` and builds `ClaimInstallParams` before forwarding to the Kotlin façade. No Rust core, uniffi, or façade change — the auto-fill is purely in the native module. The TS `claimInstall` signature widens to optional params.

**Tech Stack:** Kotlin (Expo Android module, `com.android.installreferrer`, kotlinx-coroutines), TypeScript (sdk-rn/src, Vitest).

## Global Constraints

- Stay on the current git branch (main); never switch/create branches/worktrees; commit on current HEAD.
- Conventional commits.
- No Rust/uniffi/sdk-kotlin-façade change — `claim_install(ClaimInstallParams)` and the udl are untouched. Auto-fill happens in `packages/sdk-rn/android/.../RovenueModule.kt` only.
- The SDK sends the **raw** Install Referrer string in `installReferrer`; the backend (`parseInstallReferrer`) extracts `rovenue_funnel_token`. Do NOT parse the referrer in the SDK.
- Caller-supplied params **override** auto-collected values.
- Referrer is read **on demand** per `claimInstall` call (once-per-install dedup is A's `funnel_claim_state`, used by sub-project E — not here).
- iOS `claimInstall` keeps A's pass-through behavior (no iOS auto-collection — that's sub-project C).
- **Verification reality (important):** `packages/sdk-rn/android` has NO standalone gradle wrapper — it compiles only inside a consuming Expo app build, and `InstallReferrerClient` needs an Android runtime + Play Store. So the Android native code (Task 2) is **review-verified + real-app integration only** — there is no unit/compile gate for it in this repo. The TS change (Task 1) IS fully testable (Vitest + tsc). Do not write fake gradle commands for the Android module; if any monorepo build path can type-check it, use it, otherwise rely on review.

---

### Task 1: TS — optional `claimInstall` params + tests

**Files:**
- Modify: `packages/sdk-rn/src/api/funnel.ts`
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts:134`
- Test: `packages/sdk-rn/src/api/funnel.test.ts`

**Interfaces:**
- Consumes: existing `getNative().claimInstall`, `call()`, `parse()` (from A).
- Produces: `claimInstall(params?: Partial<ClaimInstallParams>) => Promise<FunnelClaimResult | null>` — the native module (Task 2) fills missing fields on Android.

- [ ] **Step 1: Write the failing test**

In `packages/sdk-rn/src/api/funnel.test.ts`, add to the existing `describe("funnel claim", ...)` block (the mock + `claimInstall` mock fn already exist from A):

```typescript
  it("claimInstall() with no args forwards an empty object to native", async () => {
    claimInstall.mockResolvedValue(null);
    await ci();
    expect(claimInstall).toHaveBeenCalledWith({});
  });

  it("claimInstall passes caller overrides through unchanged", async () => {
    claimInstall.mockResolvedValue({ subscriberId: "s", funnelAnswersJson: "{}" });
    await ci({ installReferrer: "rovenue_funnel_token%3Dabc" });
    expect(claimInstall).toHaveBeenCalledWith({ installReferrer: "rovenue_funnel_token%3Dabc" });
  });
```

(`ci` is the existing import alias `import { claimInstall as ci } from "./funnel"`. If the test file doesn't already alias it, add `claimInstall as ci` to the import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test`
Expected: FAIL — `claimInstall()` called with no args is currently a type error / passes `undefined` not `{}` (and tsc rejects the missing required arg).

- [ ] **Step 3: Widen the `claimInstall` signature**

In `packages/sdk-rn/src/api/funnel.ts`, change:

```typescript
export async function claimInstall(params: ClaimInstallParams): Promise<FunnelClaimResult | null> {
  return call(async () => {
    const n = (await getNative().claimInstall(params)) as NativeClaim | null;
    return n ? parse(n) : null;
  });
}
```

to:

```typescript
export async function claimInstall(
  params: Partial<ClaimInstallParams> = {},
): Promise<FunnelClaimResult | null> {
  return call(async () => {
    const n = (await getNative().claimInstall(params)) as NativeClaim | null;
    return n ? parse(n) : null;
  });
}
```

- [ ] **Step 4: Widen the native spec type**

In `packages/sdk-rn/src/specs/RovenueModule.types.ts:134`, change the `claimInstall` param type so every field is optional (the native module tolerates missing keys and auto-fills):

```typescript
  claimInstall(params: { platform?: string; locale?: string; timezone?: string; screenDims?: string; deviceModel?: string; installReferrer?: string }): Promise<{ subscriberId: string; funnelAnswersJson: string } | null>;
```

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `cd packages/sdk-rn && pnpm test -- funnel.test && pnpm build`
Expected: PASS (the 2 new tests + existing) and tsc=0. If `_mockNative.ts`'s `claimInstall` stub signature now mismatches the widened spec, relax its param type to match (note it in the commit).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-rn/src/api/funnel.ts packages/sdk-rn/src/specs/RovenueModule.types.ts \
        packages/sdk-rn/src/api/funnel.test.ts packages/sdk-rn/src/__tests__/_mockNative.ts
git commit -m "feat(sdk-rn): make claimInstall params optional (native auto-fill)"
```

---

### Task 2: Android native — Install Referrer + device context auto-fill

**Files:**
- Modify: `packages/sdk-rn/android/build.gradle`
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`

**Interfaces:**
- Consumes: the existing `Rovenue.shared.claimInstall(ClaimInstallParams)` façade method; `appContext.reactContext?.applicationContext`; the generated `ClaimInstallParams` data class (`platform, locale, timezone, screenDims, deviceModel?, installReferrer?`).
- Produces: the JS-callable `claimInstall` that auto-fills missing fields on Android.

**Verification note:** No standalone compile/unit gate exists for this module (see Global Constraints). The implementer must self-review against the `InstallReferrerClient` API surface below; the reviewer scrutinizes the lifecycle/error handling; real verification is a consuming Expo app build on a device/emulator with Play Store.

- [ ] **Step 1: Add the Install Referrer dependency**

In `packages/sdk-rn/android/build.gradle`, add to the `dependencies { ... }` block (next to the existing `kotlinx-coroutines-core`):

```gradle
    implementation 'com.android.installreferrer:installreferrer:2.2'
```

- [ ] **Step 2: Add imports**

In `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`, add to the import block (alphabetically among the existing imports):

```kotlin
import android.content.res.Resources
import android.util.DisplayMetrics
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import java.util.Locale
import java.util.TimeZone
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
```

(`android.content.Context` and `android.os.Build` are already imported.)

- [ ] **Step 3: Add the device-context helper**

Add these private members to the `RovenueModule` class (near the existing `readPackageVersionName()`):

```kotlin
    private data class AndroidInstallContext(
        val locale: String,
        val timezone: String,
        val screenDims: String,
        val deviceModel: String,
    )

    /** Collects the device context the backend's claim-install requires.
     *  No fingerprinting concern on Android (Google-sanctioned referrer flow). */
    private fun collectAndroidContext(): AndroidInstallContext {
        val ctx: Context? = appContext.reactContext?.applicationContext
        val dm: DisplayMetrics = ctx?.resources?.displayMetrics ?: Resources.getSystem().displayMetrics
        return AndroidInstallContext(
            locale = Locale.getDefault().toLanguageTag(),
            timezone = TimeZone.getDefault().id,
            screenDims = "${dm.widthPixels}x${dm.heightPixels}",
            deviceModel = Build.MODEL ?: "",
        )
    }
```

- [ ] **Step 4: Add the Install Referrer reader**

Add this private suspend function to the `RovenueModule` class:

```kotlin
    /** Reads the raw Google Play Install Referrer once, with a 3s connection
     *  timeout. Returns null when unavailable (no Play Store, sideloaded,
     *  FEATURE_NOT_SUPPORTED/SERVICE_UNAVAILABLE, timeout, or any error). The
     *  raw string is parsed server-side (parseInstallReferrer → rovenue_funnel_token). */
    private suspend fun readInstallReferrer(): String? {
        val ctx: Context = appContext.reactContext?.applicationContext ?: return null
        return withTimeoutOrNull(3_000L) {
            val client = InstallReferrerClient.newBuilder(ctx).build()
            try {
                suspendCancellableCoroutine<String?> { cont ->
                    client.startConnection(object : InstallReferrerStateListener {
                        override fun onInstallReferrerSetupFinished(responseCode: Int) {
                            val result = try {
                                if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                                    client.installReferrer.installReferrer
                                } else {
                                    null
                                }
                            } catch (_: Throwable) {
                                null
                            }
                            if (cont.isActive) cont.resume(result)
                        }

                        override fun onInstallReferrerServiceDisconnected() {
                            if (cont.isActive) cont.resume(null)
                        }
                    })
                }
            } catch (_: Throwable) {
                null
            } finally {
                try {
                    client.endConnection()
                } catch (_: Throwable) {
                    // best-effort
                }
            }
        }
    }
```

- [ ] **Step 5: Auto-fill in the `claimInstall` AsyncFunction**

Replace the existing `AsyncFunction("claimInstall") Coroutine { ... }` block (from sub-project A) with:

```kotlin
        AsyncFunction("claimInstall") Coroutine { params: Map<String, Any?> ->
            val ctx = collectAndroidContext()
            val p = ClaimInstallParams(
                platform = params["platform"] as? String ?: "android",
                locale = params["locale"] as? String ?: ctx.locale,
                timezone = params["timezone"] as? String ?: ctx.timezone,
                screenDims = params["screenDims"] as? String ?: ctx.screenDims,
                deviceModel = params["deviceModel"] as? String ?: ctx.deviceModel,
                installReferrer = params["installReferrer"] as? String ?: readInstallReferrer(),
            )
            val r = Rovenue.shared.claimInstall(p) ?: return@Coroutine null
            mapOf("subscriberId" to r.subscriberId, "funnelAnswersJson" to r.funnelAnswersJson)
        }
```

- [ ] **Step 6: Static self-check (best effort)**

Run: `git diff --stat` and re-read the changed `RovenueModule.kt` against the `InstallReferrerClient` API used (`newBuilder(context).build()`, `startConnection(listener)`, `InstallReferrerResponse.OK`, `installReferrer.installReferrer`, `endConnection()`). Confirm imports resolve and `ClaimInstallParams` field names match the generated data class (`platform, locale, timezone, screenDims, deviceModel, installReferrer`). There is no standalone gradle build for this module — note in the report that compile/runtime verification requires a consuming Expo app build. If the monorepo exposes any task that type-checks this module, run it and report the result.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-rn/android/build.gradle \
        packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt
git commit -m "feat(sdk-rn): auto-collect Android Install Referrer + device context in claimInstall"
```

---

### Task 3: Version bump + docs

**Files:**
- Modify: `Cargo.toml`, `packages/sdk-rn/src/version.ts`, `packages/sdk-rn/package.json` (lockstep)
- Modify: `apps/docs/content/docs/reference/methods.mdx`

**Verification note:** Confirm the three current version values are identical before bumping (the scheme is unified; `version.test.ts` asserts equality).

- [ ] **Step 1: Bump all three versions in lockstep**

Read the current version (all three must already be equal, e.g. `0.10.0`). Bump each by one minor to the next value (e.g. `0.10.0` → `0.11.0`):
- `/Volumes/Development/rovenue/Cargo.toml` `[workspace.package]` `version`
- `packages/sdk-rn/src/version.ts` `SDK_VERSION`
- `packages/sdk-rn/package.json` `version`
All three MUST end identical.

- [ ] **Step 2: Update the docs**

In `apps/docs/content/docs/reference/methods.mdx`, update the `### claimInstall` section (added in A) to reflect auto-collection:
- Change the params description: params are now **optional** — on Android the SDK auto-collects `platform`, `locale`, `timezone`, `screenDims`, `deviceModel`, and the Play Install Referrer; pass fields only to override. On iOS, callers still supply context (until iOS support lands).
- Update the React Native example to the argument-less form:
```ts
const result = await Rovenue.claimInstall(); // Android: auto-collects referrer + context
```
- Keep the Swift/Kotlin façade examples as-is (the façade still takes explicit params; auto-fill is the JS/native-module layer).
Do not introduce un-imported MDX components.

- [ ] **Step 3: Verify**

Run: `cargo build -p librovenue && cd packages/sdk-rn && pnpm test`
Expected: crate builds at the new version; sdk-rn tests pass INCLUDING `version.test.ts` (parity at the new version across all three). `pnpm --filter @rovenue/docs build` may fail only on the known pre-existing SSR home-page crash — confirm it's that and not your MDX.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock packages/sdk-rn/src/version.ts packages/sdk-rn/package.json apps/docs/content/docs/reference/methods.mdx
git commit -m "chore(sdk): bump versions + document Android claimInstall auto-collection"
```

---

## Self-Review

**Spec coverage:**
- §4 optional `claimInstall(params?)` → Task 1.
- §5.1 installreferrer dep → Task 2 Step 1; §5.2 `readInstallReferrer` + `collectAndroidContext` + auto-fill → Task 2 Steps 3-5; §5.3 TS optional + spec → Task 1.
- §6 testing: TS testable (Task 1); Android native review-only (Task 2, stated). §7 versioning → Task 3.
- Raw referrer (no SDK parse), caller-override, on-demand read, iOS untouched → all reflected in Task 2's code + Global Constraints.

**Placeholder scan:** No TBD/TODO. Task 2 contains complete Kotlin (no compile gate exists; the code is given in full so it doesn't need iteration). The "static self-check" step is explicit about the verification limitation, not a vague instruction.

**Type consistency:** `claimInstall(params?: Partial<ClaimInstallParams>)` (TS) ↔ widened `RovenueModuleSpec` param ↔ native `Map<String, Any?>` → `ClaimInstallParams(platform, locale, timezone, screenDims, deviceModel, installReferrer)` (generated field names). `AndroidInstallContext` fields map 1:1 to the auto-filled `ClaimInstallParams` fields. The façade/core `claim_install(ClaimInstallParams)` is unchanged.
