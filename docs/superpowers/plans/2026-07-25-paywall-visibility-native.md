# Paywall Node Visibility — Stage 2 (Native Renderers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the React Native, Android Views and SwiftUI paywall renderers honour node `visibility`, each proven against the shared vector table stage 1 made fail-able.

**Architecture:** Each renderer already decodes-and-drops the `visibility` key. Per SDK: parse and retain it, port `isNodeVisible` + `compareVersions` as pure functions, thread the platform (a per-SDK constant, or `Platform.OS`) and the app version (already received at `configure()`) into the render context, and gate the node dispatch on it before overrides. Each SDK's existing `render-fixtures.json` test gains a loop over the `visibility` section.

**Tech Stack:** TypeScript/React Native (Vitest), Kotlin/Android (`testDebugUnitTest`), Swift/SwiftUI (`swift test`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-25-paywall-visibility-native-design.md`.
- **Reference implementation:** `packages/shared/src/paywall/visibility.ts`. Every port must agree with it case-for-case.
- **Contract:** `render-fixtures.json`'s `visibility` array — 13 `{ visibility, platform, appVersion, expected }` cases. A port that disagrees is wrong, not the vector.
- The four rules a naive port gets wrong (spec §2): component-wise digit comparison (`1.10 > 1.9`, `1.2 == 1.2.0`); a non-numeric component is inconclusive and **must not throw** when parsed; fail open on every unknown; a hidden node renders neither its `fallback` nor its children (gate before descending).
- Bounds are inclusive.
- No Rust change. No wire, DB or schema change — `visibility` shipped in stage 1.
- No magic values; platform strings are `"ios"`, `"android"`, `"web"`.
- Verify Kotlin with `testDebugUnitTest`, RN with `vitest`, Swift with `swift test` where runnable. A compile is not a test.
- **Stay on the current branch (`main`).** No branches, no worktrees.
- Conventional commits; commit per task. The three tasks are independent — one being blocked does not block the others.

---

### Task 1: React Native

**Files:**
- Modify: `packages/sdk-rn/src/paywall-ui/model.ts` — decode + retain `visibility`.
- Create: `packages/sdk-rn/src/paywall-ui/visibility.ts` — the RN evaluator (near-copy of shared).
- Create: `packages/sdk-rn/src/paywall-ui/__tests__/visibility.test.ts`
- Modify: `packages/sdk-rn/src/paywall-ui/__tests__/model.test.ts` — run the vector section.
- Modify: `packages/sdk-rn/src/paywall-ui/RovenuePaywallView.tsx` — thread platform/appVersion into `Ctx`, gate `NodeView`.
- Modify: `packages/sdk-rn/src/api/configure.ts` — stash the app version JS-side.
- Modify: `packages/sdk-rn/src/paywall-ui/RovenuePaywallView.tsx` render test (its existing test file) — the three render cases.

**Interfaces:**
- Produces: `NodeVisibility` on every `BuilderNode` variant; `isNodeVisible(v, ctx)` / `compareVersions(a, b)` in `visibility.ts`; `Ctx` gains `platform: "ios" | "android"` and `appVersion: string | null`.

- [ ] **Step 1: Port the evaluator with its own tests**

Create `packages/sdk-rn/src/paywall-ui/visibility.ts` as a direct port of `packages/shared/src/paywall/visibility.ts` — the same `compareVersions` (exact digit-string comparison, `null` on a non-numeric component) and the same `isNodeVisible` (fail open on empty platform list, null platform, null version, inconclusive comparison). Keep the fail-open comments; they are load-bearing here too.

Create `packages/sdk-rn/src/paywall-ui/__tests__/visibility.test.ts` mirroring the shared `visibility.test.ts`, including every case named "FAILS OPEN". Run it: `pnpm --filter @rovenue/sdk-rn exec vitest run src/paywall-ui/__tests__/visibility.test.ts`. Expected: green.

- [ ] **Step 2: Decode and retain `visibility`**

In `model.ts`, add a `NodeVisibility` type to the model and a `parseVisibility(o: Obj): NodeVisibility | undefined` helper: read `platform` (an array, keeping only `"ios"|"android"|"web"` strings — drop unrecognised ones leniently, and treat an all-dropped/empty result as `undefined`), `minAppVersion` and `maxAppVersion` (strings). In `parseNode`, compute `const visibility = parseVisibility(o)` next to the existing `const fallback = …`, add `visibility?: NodeVisibility` to every node variant in the `BuilderNode` union, and add `visibility,` to every node's returned object.

- [ ] **Step 3: Run the contract vector table**

In `__tests__/model.test.ts`, add a loop over `fixture.visibility` that runs the RN `isNodeVisible` and asserts `expected`:

```ts
import { isNodeVisible } from "../visibility";
// … inside the describe:
for (const v of fixture.visibility) {
  it(`visibility vector: ${v.name}`, () => {
    expect(isNodeVisible(v.visibility, { platform: v.platform, appVersion: v.appVersion })).toBe(v.expected);
  });
}
```

Type `fixture.visibility` to match the shared section. Run the model test. This is the conformance proof — a wrong comparator or a dropped field fails a named vector.

- [ ] **Step 4: Thread the two facts and gate the dispatch**

- `configure.ts`: keep a module-scoped `let configuredAppVersion: string | null = null;` and set it in `configure()` from `opts.appVersion ?? null`, with a small exported getter. It is already in JS hands; this only makes it readable by the render layer.
- `RovenuePaywallView.tsx`: `import { Platform } from "react-native";`, read the app version via the getter, add `platform: Platform.OS === "ios" ? "ios" : "android"` and `appVersion` to the `Ctx` literal, and widen the `Ctx` type.
- In `NodeView`, before `applyOverrides`/dispatch, return `null` when `!isNodeVisible(node.visibility, { platform: ctx.platform, appVersion: ctx.appVersion })`. Gate on `node.visibility`, not the resolved node — visibility is not overridable.

- [ ] **Step 5: The three render cases**

In the existing `RovenuePaywallView` render test, add: a text node `visibility: { platform: ["android"] }` renders nothing under an iOS platform and renders under Android; a hidden stack takes its children; a hidden node with a `fallback` renders neither. Force the platform in the test rather than relying on the host — parameterise `Ctx.platform` or the module getter as the test harness allows.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @rovenue/sdk-rn exec vitest run src/paywall-ui` (all paywall-ui tests) and `pnpm --filter @rovenue/sdk-rn exec tsc --noEmit`.

```bash
git add packages/sdk-rn/src/paywall-ui packages/sdk-rn/src/api/configure.ts
git commit -m "feat(sdk-rn): honour node visibility in the paywall renderer"
```

---

### Task 2: Android (Kotlin)

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModel.kt` — decode + retain.
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/NodeViewFactory.kt` — `PaywallRenderContext` gains `appVersion`; `build` gates.
- Create: a `Visibility.kt` (or a function set in an existing file) with `isNodeVisible` + `compareVersions`.
- Modify: `RovenuePaywallView.kt` — pass the app version into the context; platform is the constant `"android"`.
- Modify: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModelTest.kt` — run the vector section.
- Create/modify: a visibility unit test.

**Interfaces:**
- Produces: `visibility` on the `BuilderNode` sealed model; a pure `isNodeVisible(visibility, platform, appVersion)` + `compareVersions`; `PaywallRenderContext` gains `appVersion: String?`.

- [ ] **Step 1: Port the evaluator**

Port `compareVersions` and `isNodeVisible` into Kotlin from `visibility.ts`. `compareVersions` returns `Int?` (`null` = inconclusive). **Parse digits with `toIntOrNull()` and treat any `null` component as inconclusive — never `toInt()`, which throws on `"beta"`.** Compare component strings the same way the TS `compareComponent` does (strip leading zeros, then length-then-lexical) so it is exact past `Int.MAX_VALUE`; or, if using `Int`, add a fixture-covered note — but the vector table has a beyond-safe-range case, so exact string comparison is the safe port. `isNodeVisible(platform: String?, appVersion: String?)` fails open on every unknown.

Add a unit test for the evaluator mirroring the shared cases, including the fail-open ones.

- [ ] **Step 2: Decode and retain**

In `BuilderConfigModel.kt`, add a `Visibility` data class (`platform: List<String>?`, `minAppVersion: String?`, `maxAppVersion: String?`) and a decode that keeps only known platform strings leniently. Add `visibility: Visibility?` to the `BuilderNode` model and populate it in the decoder for every node type.

- [ ] **Step 3: Run the contract vector table**

In `BuilderConfigModelTest.kt`, which already reads `render-fixtures.json`, add a loop over the `visibility` array running the Kotlin `isNodeVisible` and asserting `expected`. This is the conformance proof.

- [ ] **Step 4: Thread app version and gate**

- `PaywallRenderContext` gains `appVersion: String?`.
- `RovenuePaywallView.kt` passes the SDK's configured app version in, and `"android"` is the constant platform.
- `NodeViewFactory.build` returns `null` (the node renders nothing) when `!isNodeVisible(node.visibility, "android", ctx.appVersion)`, before overrides are applied. A hidden node contributes no view and no fallback.

- [ ] **Step 5: The render cases**

Add Kotlin unit tests (or NodeViewFactory tests, mirroring the existing ones) for: a node hidden by platform builds no view; a hidden stack contributes none of its children; a hidden node with a fallback builds neither.

- [ ] **Step 6: Verify and commit**

Verify with `testDebugUnitTest` (per project convention, not a bare compile):
`cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "*paywallui*"`

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui
git commit -m "feat(sdk-kotlin): honour node visibility in the paywall renderer"
```

---

### Task 3: iOS (Swift)

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/BuilderConfigModel.swift` — decode + retain.
- Create: a `Visibility.swift` with `isNodeVisible` + `compareVersions`, or add to `PaywallRenderSupport.swift`.
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/RovenuePaywallView.swift` — `ctx` gains the app version; platform is the constant `"ios"`; `BuilderNodeView` gates.
- Modify: `packages/sdk-swift/Tests/RovenueTests/BuilderConfigModelTests.swift` — run the vector section.
- Create/modify: a visibility test.

**Interfaces:**
- Produces: `visibility` on the node model; a pure `isNodeVisible(_:platform:appVersion:)` + `compareVersions`; the render `ctx` gains an app version.

- [ ] **Step 1: Port the evaluator**

Port `compareVersions` and `isNodeVisible` into Swift. `compareVersions` returns `Int?` (`nil` = inconclusive). **Parse digits with `Int(component)` guarded — a `nil` makes the comparison inconclusive; never force-unwrap.** Use the exact digit-string comparison (strip leading zeros, length-then-lexical) so the beyond-`Int.max` vector passes. `isNodeVisible` fails open on every unknown.

Add a test for the evaluator mirroring the shared cases, including the fail-open ones.

- [ ] **Step 2: Decode and retain**

In `BuilderConfigModel.swift`, add a `Visibility` type (`platform: [String]?`, `minAppVersion: String?`, `maxAppVersion: String?`) decoded leniently (unknown platform strings dropped), and carry `visibility` on the node model, populated for every node type. Swift `Codable` will ignore the key unless the model declares it, so this is the retain step.

- [ ] **Step 3: Run the contract vector table**

In `BuilderConfigModelTests.swift`, which already reads `render-fixtures.json`, loop over the `visibility` array running the Swift `isNodeVisible` and asserting `expected`.

- [ ] **Step 4: Thread app version and gate**

- The render `ctx` gains the app version; `RovenuePaywallView` passes the SDK's configured value; `"ios"` is the constant platform.
- `BuilderNodeView.body` returns `EmptyView()` when `!isNodeVisible(node.visibility, platform: "ios", appVersion: ctx.appVersion)`, before overrides. A hidden node renders neither its fallback nor its children.

- [ ] **Step 5: The render/support cases**

Add tests (following `PaywallRenderSupportTests` / `PaywallOverridesTests`) for the platform-hidden, hidden-stack-children, and hidden-with-fallback cases at whatever level the Swift suite tests rendering (a support-function test if the view body is not unit-testable).

- [ ] **Step 6: Verify and commit**

Run `swift test` from `packages/sdk-swift` if the toolchain is available. **If it is not runnable in this environment, say so plainly** — write the diff to meet the same vector table, and record that Swift was not locally executed rather than claiming a pass.

```bash
git add packages/sdk-swift/Sources/Rovenue/PaywallUI packages/sdk-swift/Tests/RovenueTests
git commit -m "feat(sdk-swift): honour node visibility in the paywall renderer"
```

---

## Post-implementation verification

1. RN: `pnpm --filter @rovenue/sdk-rn exec vitest run src/paywall-ui` green; `tsc --noEmit` clean.
2. Kotlin: `./gradlew testDebugUnitTest --tests "*paywallui*"` green.
3. Swift: `swift test` green where runnable; otherwise the limitation is recorded.
4. All three run the same `render-fixtures.json` `visibility` vectors and agree with `isNodeVisible`.
5. Manual device smoke (out of CI): a node set to one platform appears there and not on the other; deferred to a device session.

## Out of scope

- Rust core (already carries platform/app_version).
- Stage 1's deferred dashboard UI minors.
- The device smoke session itself.
