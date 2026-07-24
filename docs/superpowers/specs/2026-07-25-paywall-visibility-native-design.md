# Paywall Node Visibility — Stage 2 (Native Renderers) Design

**Date:** 2026-07-25
**Status:** Proposed. Feeds a writing-plans implementation plan.
**Phase:** P5b stage 2 of the paywall-builder redesign. Stage 1 (TypeScript) shipped: the model, the web renderer, the canvas, the inspector tab, and a fail-able four-platform contract.

---

## 1. What stage 1 left, verified

Stage 1 wrote a contract three decoders must now meet, and proved it can fail. Checked against the real native code before writing this:

| Fact | Reality |
|---|---|
| `visibility` on the wire | Present, optional, on every node (stage 1). All three native decoders **already ignore** unknown keys, so today they decode-and-drop it. |
| The contract to meet | `render-fixtures.json`'s new `visibility` vector section — 13 `{ visibility, platform, appVersion } → expected boolean` cases. `isNodeVisible` (TS) is proven against it; a lexical-compare regression turns it red. |
| Each renderer's shape | Identical across the three: a decoder (`model.ts` / `BuilderConfigModel.swift` / `BuilderConfigModel.kt`), a render context (`Ctx` / `PaywallRenderContext` / SwiftUI `ctx`), and a single node-dispatch (`NodeView` / `BuilderNodeView` / `NodeViewFactory.build`). All three already consume `render-fixtures.json`. |
| Where platform comes from | **A near-constant per SDK.** Swift is always `ios`; Kotlin is always `android`; RN is `Platform.OS` (`ios` or `android`). None is ever `web`, so a web-only node is correctly hidden on all three natives. |
| Where app version comes from | Each SDK receives it at `configure()` time (`RovenueConfig.appVersion` / `app_version`). It is **not** in the render layer today — the render context carries the paywall tree, not the SDK config. Threading it in is the one real piece of plumbing. |

So the design work is small and the labour is a disciplined three-way port. The vector table means each port is "make these 13 cases pass in language X", not a fresh design decision three times.

---

## 2. The four rules, restated for a porter

Each native evaluator must agree with `isNodeVisible` case-for-case. The rules that a naive port gets wrong, in priority order:

1. **Version comparison is component-wise on digits, not lexical and not semver.** `1.10 > 1.9`; `1.2 == 1.2.0` (missing components are zero). A decoder that does `"1.10".split(".").map(Int)` and compares lists element-by-element gets the numeric part right; one that compares the strings does not.
2. **A non-numeric component is inconclusive, and inconclusive fails open.** `"1.0.0-beta"` must not throw when split and parsed — it must be caught and treated as "cannot compare → visible". This is the single most likely crash site: `Int("beta")` / `"beta".toInt()` throw.
3. **Fail open on every unknown.** Unknown platform (never happens on a native, but the code must still not hide), unknown app version (both bounds pass), empty platform list (means "all"), unparseable version (rule 2).
4. **A hidden node renders nothing — not its `fallback`, and not its children.** `fallback` is for decode failure; hidden is the author's choice. The gate returns before descending, so children go with it.

Bounds are **inclusive**: `minAppVersion` and `maxAppVersion` both match on equality.

---

## 3. Per-SDK plan

Identical structure, three languages:

**Decode.** Parse `visibility` in the node decoder and retain it on the node model: `platform: [String]?`, `minAppVersion: String?`, `maxAppVersion: String?`. Leniently — an unrecognised platform string is dropped from the array, not a decode failure, matching how the natives already treat unknowns (and matching stage 1's note that reading is lenient while authoring is strict).

**Evaluate.** Port `isNodeVisible` and `compareVersions` as pure functions. This is the code the vector table pins. Kotlin and Swift get real `compareVersions` with a try/catch (or `toIntOrNull`) around the digit parse; RN reuses the exact TS algorithm.

**Plumb the two facts into the render context.**
- Platform: `ios` (Swift, constant), `android` (Kotlin, constant), `Platform.OS` (RN).
- App version: stash what `configure()` already receives so the render layer can read it. In RN that is a module-scoped value set in `configure`; in Swift/Kotlin the stored SDK config the paywall entry point already has access to.

**Gate.** At the top of the node dispatch, before overrides are applied, return the empty view when `isNodeVisible` is false.

**Prove it.** Each SDK's existing `render-fixtures.json` test gains a loop over the `visibility` vector section, running that SDK's evaluator and asserting `expected`. This is the conformance proof and the thing that makes the three ports actually agree rather than merely compile.

---

## 4. Staging

One task per platform, each self-contained and independently shippable, because they share nothing but the contract file:

- **RN** first — it is TypeScript, its evaluator is a near-copy of the shared one, and its tests run under `vitest`, so it is the cheapest place to shake out a wrong vector before three languages carry it.
- **Kotlin** second — `testDebugUnitTest` runs locally.
- **Swift** third — verified with `swift test` where the toolchain is available; if it cannot be run in this environment, the diff is written to meet the same vector table and that limitation is stated plainly rather than claimed as passing.

No task depends on another. If one platform's port is blocked, the other two still ship a correct renderer for their platform.

---

## 5. Testing

- **The vector table is the spine.** Each SDK runs all 13 cases through its own evaluator against the shared JSON. A port that drops `visibility` on decode, or compares versions lexically, or throws on `"1.0.0-beta"`, fails a named case.
- **A render-level test per SDK** — a node hidden by platform renders nothing, a hidden stack takes its children, a hidden node with a `fallback` renders neither — mirroring the web renderer's three.
- **The evaluator ports are pure**, so they carry the real coverage; the render tests guard the wiring.
- **What cannot be tested here** — a real device showing/hiding by actual OS version — is a manual smoke check, out of scope for CI and called out as such, not implied by a green suite.

---

## 6. Global constraints

- Rust is not touched — `RovenueConfig` already carries `platform`/`app_version`. This stage is Swift, Kotlin and RN only.
- **Wire-additive; already shipped.** `visibility` is on the wire from stage 1. No wire, DB or schema change here.
- The `render-fixtures.json` `visibility` section is the contract. A native evaluator that disagrees with a vector is wrong, not the vector — the vector is proven against the TS reference.
- No magic values; platform strings are the same three the shared enum uses.
- Verify Kotlin with `testDebugUnitTest` (not compile — it misses red tests), RN with `vitest`, Swift with `swift test` where runnable.
- Conventional commits, on `main`.

---

## 7. Follow-ons

- Stage 1's deferred UI minors (normalize a full platform list, empty-means-all copy, hidden-cellTemplate empty cells) — dashboard, unrelated to natives.
- A device smoke session across the three platforms, once all three ports land.
