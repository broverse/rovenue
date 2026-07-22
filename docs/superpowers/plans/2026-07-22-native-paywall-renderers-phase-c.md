# Native Paywall Renderers (Phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swift (SwiftUI) and Kotlin (Android Views) render the Phase-B builder-paywall component tree natively with real store prices; core plumbs `builderConfig` through; a shared fixture file is the cross-platform parser/semantics contract.

**Architecture:** `builder_config_json` raw-string through CorePaywall/UDL; per-platform decoders (Codable / kotlinx-serialization) + pure view-model helpers asserted against `packages/shared/src/paywall/render-fixtures.json`; SwiftUI + Android Views renderers mirroring the web renderer's normative semantics; auto `logPaywallShown`; purchase wired to each SDK's existing purchase path.

**Tech Stack:** Rust/uniffi, Swift 5.9 (iOS 16+), Kotlin 1.9.24 (minSdk 24, kotlinx-serialization, NO Compose), vitest.

**Spec:** `docs/superpowers/specs/2026-07-22-native-paywall-renderers-phase-c-design.md` (renderer semantics list + PackageView mapping + public API shapes are normative).

## Global Constraints

- Stay on main. NEVER branch. Stage only your own files (user may have unrelated WIP).
- NEVER commit generated uniffi bindings; regen via `npm run sdk:bindings`.
- Renderer semantics MUST mirror the web renderer (packages/paywall-renderer — the normative sibling): unknown type → fallback else nothing, never throw; empty packageIds = all offering packages; selection init `defaultSelected ?? effectiveIds[0] ?? null`; purchase disabled on null selection; restore hidden without handler; variables cell-scoped in cells, selected-scoped elsewhere; renderer NEVER opens URLs itself.
- PackageView mapping (identical both platforms): packageName=displayName; price=priceString??""; period=unit label ("day"/"week"/"month"/"year", "" for non-subs); pricePerPeriod = period=="" ? price : price+"/"+period.
- Auto-track: builder renderers call the existing `logPaywallShown(paywall)` exactly once on first appearance.
- Kotlin: NO new dependencies (no Compose, no Coil, no Robolectric unless already present). Verify with `./gradlew testDebugUnitTest`.
- Swift: verify with `swift test`; keep SwiftUI bodies thin — logic in pure helpers (no ViewInspector).
- cargo test + fmt + clippy green (CI blockers). Full `pnpm build --force` stays green.
- Conventional commits; commit per task.

---

### Task 1: Shared — render-fixtures contract file

**Files:**
- Create: `packages/shared/src/paywall/render-fixtures.json`
- Create: `packages/shared/src/paywall/render-fixtures.test.ts`

Fixture sections (per spec §2): `accept` (≥6 named configs: every node type incl. nested stacks, a node with a valid `fallback`, an unknown-type node whose `fallback` is valid — NOTE the TS schema REJECTS unknown types, so unknown-type cases live in a dedicated `acceptLenient` section consumed only by the platform decoders, with a comment explaining the asymmetry: platform decoders are lenient-by-design, the authoring schema is strict), `reject` (≥5: bad axis, missing id, formatVersion 1, malformed fallback child, non-object localization), `variables` (≥8 vectors incl. all four vars, unknown var verbatim, null pkg verbatim, multi-var strings), `resolveText` (≥4 against `accept[0]`: exact locale hit, fallback to default, missing key → null, empty-string value round-trips as "").

- [x] **Step 1 (TDD):** render-fixtures.test.ts — loads the JSON; every `accept` config passes `builderConfigSchema.safeParse`; every `reject` fails; every `variables` vector matches `resolveVariables`; every `resolveText` vector matches `resolveText`; `acceptLenient` entries FAIL the strict schema (asserting the asymmetry is intentional). Run → FAIL (file missing).
- [x] **Step 2:** Generate the fixture with a scratchpad script executing the real TS helpers (accept configs authored by hand, expected values computed — same discipline as bucketing-vectors). Paste, freeze.
- [x] **Step 3:** `pnpm --filter @rovenue/shared test` green. Commit: `feat(shared): cross-platform paywall render fixtures`.

---

### Task 2: Core + façade plumbing — builderConfig reaches every platform

**Files:**
- Modify: `packages/core-rs/src/placements/types.rs` (`PaywallWire.builder_config: Option<serde_json::Value>` serde default; `CorePaywall.builder_config_json: Option<String>`), `packages/core-rs/src/placements/client.rs` (map it verbatim), `packages/core-rs/src/librovenue.udl` (`string? builder_config_json`)
- Modify: `packages/core-rs/tests/placements_test.rs` (fixture response gains builderConfig; assert round-trip + cache-serve keeps it; absent field still decodes)
- Modify: Swift `Types.swift` Paywall += `builderConfigJson: String?` + mapping in Internal/PaywallMapping.swift; Kotlin `Types.kt` Paywall += `builderConfigJson: String?` + mapping in internal/PaywallMapping.kt; RN: `PaywallDTO.builderConfigJson` (specs/RovenueModule.types.ts), bridge mappings (RovenueModule.swift/.kt), `Paywall.builderConfig` parsed via the existing `parseRemoteConfig`-style tolerant helper in src/api/paywalls.ts + DTO test
- Test: existing façade mapping tests extended (Swift PaywallMappingTests, Kotlin PaywallMappingTest, RN paywalls.test.ts)

**Interfaces (Produces):** `CorePaywall.builder_config_json` / Swift `Paywall.builderConfigJson` / Kotlin `Paywall.builderConfigJson` / RN `Paywall.builderConfig: Record<string,unknown> | null` — consumed by Tasks 3-7.

- [x] **Step 1 (TDD):** extend the Rust placements test + the three façade mapping tests (present → carried verbatim; absent → null) → RED. **Step 2:** implement + regen bindings. **Step 3:** cargo test/fmt/clippy green; `swift test`, `./gradlew testDebugUnitTest`, RN vitest+tsc green. **Step 4:** Commit: `feat(sdk): builderConfig plumbed through core to all façades`.

---

### Task 3: Swift — builder-config decoder + pure view-model helpers

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/PaywallUI/{BuilderConfigModel.swift,PaywallViewModelHelpers.swift,PackageViewMapping.swift}`
- Test: `packages/sdk-swift/Tests/RovenueTests/{BuilderConfigModelTests.swift,PaywallViewModelHelpersTests.swift}`

**Interfaces (Produces):**
```swift
enum BuilderNode: Decodable { case stack(StackProps), text(TextProps), image(ImageProps), button(ButtonProps),
  packageList(PackageListProps), purchaseButton(PurchaseButtonProps), spacer(SpacerProps),
  unknown(id: String, fallback: BuilderNodeBox?) }   // lenient: unknown type keeps id+fallback, never throws
struct BuilderConfigModel: Decodable { let formatVersion: Int; let defaultLocale: String;
  let localizations: [String: [String: String]]; let background: ThemePair?; let root: BuilderNode }
struct ThemePair: Decodable { let light: String; let dark: String? }
func decodeBuilderConfig(_ json: String) -> BuilderConfigModel?          // nil on malformed — never throws
func resolveText(_ c: BuilderConfigModel, locale: String?, key: String) -> String?
func resolveVariables(_ text: String, pkg: PackageView?) -> String
struct PackageView { let packageName, price, pricePerPeriod, period: String }
func packageView(from product: StoreProduct?, displayName: String) -> PackageView   // spec mapping
func effectivePackageIds(_ node: PackageListProps, offering: Offering?) -> [String]
func initialSelection(_ root: BuilderNode, offering: Offering?) -> String?
```
Fixture loading: `URL(fileURLWithPath: #filePath)` → walk up to `packages/shared/src/paywall/render-fixtures.json` (tests only; the fixture is NOT bundled in the library).

- [x] **Step 1 (TDD):** tests — every fixture `accept` + `acceptLenient` decodes (lenient unknown-type keeps fallback); every `reject` yields nil OR decodes-with-unknown ONLY where the defect is an unknown type (assert per-case per a `lenientExpectation` field in the fixture if needed — coordinate: if the fixture lacks it, add it in packages/shared with a matching vitest update, that's in-contract); all `variables` + `resolveText` vectors match; PackageView mapping table (sub month/year/week/day, non-sub, nil product); selection-init cases mirroring the web renderer tests. → RED. **Step 2:** implement. **Step 3:** `swift test` green. **Step 4:** Commit: `feat(sdk-swift): builder-config decoder and paywall view-model helpers`.

---

### Task 4: Swift — RovenuePaywallView (SwiftUI)

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/PaywallUI/{RovenuePaywallView.swift,NodeViews.swift}`
- Test: extend helper tests for any logic extracted while building views (purchase-enabled state, action routing table)

Public API exactly per spec §3. Rendering: VStack/HStack/ZStack, theme pairs via `colorSchemeOverride ?? environment`, AsyncImage for images, package cells as Buttons with selection state, purchase button calls the SDK's existing package-purchase API (LOCATE it in Rovenue.swift — the purchases section; wire the selected packageIdentifier → offering package → that call; completion → onPurchaseCompleted/onPurchaseFailed), auto `logPaywallShown` once in onAppear (guard a @State flag), restore hidden when onRestore nil, url buttons call onUrl only (never open). No builderConfigJson → EmptyView.

- [x] **Step 1:** implement (TDD where logic is pure — extract + test action-routing/purchase-enabled helpers first). **Step 2:** `swift test` green (all suites); the package must still compile for macOS too (guard iOS-only APIs with #if canImport(UIKit) where needed). **Step 3:** Commit: `feat(sdk-swift): native SwiftUI renderer for builder paywalls`.

---

### Task 5: Kotlin — decoder + pure helpers

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/{BuilderConfigModel.kt,PaywallHelpers.kt,PackageViewMapping.kt}`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/{BuilderConfigModelTest.kt,PaywallHelpersTest.kt}`

Mirror of Task 3 in Kotlin: kotlinx-serialization polymorphic-by-`type` decoding with a lenient unknown branch (custom JsonContentPolymorphicSerializer — unknown `type` → UnknownNode(id, fallback)), `decodeBuilderConfig(json): BuilderConfigModel?` never throws, resolveText/resolveVariables ports, PackageView mapping per spec, effectivePackageIds/initialSelection. Fixture via `File("../shared/src/paywall/render-fixtures.json")` relative to the gradle project dir (packages/sdk-kotlin) — verify the relative path in the test, fail loud with a clear message if missing.

- [x] **Step 1 (TDD):** same case matrix as Swift Task 3 → RED. **Step 2:** implement. **Step 3:** `./gradlew testDebugUnitTest` green. **Step 4:** Commit: `feat(sdk-kotlin): builder-config decoder and paywall helpers`.

---

### Task 6: Kotlin — RovenuePaywallView (Android Views)

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/{RovenuePaywallView.kt,NodeViewFactory.kt,PaywallViewOptions.kt}`
- Test: pure-logic additions only (view construction is manually smoked; do NOT add Robolectric if absent — check first and state what you found)

Public API exactly per spec §4. LinearLayout (v/h) / FrameLayout (z); TextView/ImageView(+minimal URL loader on a background coroutine, no Coil)/Button widgets styled programmatically from the schema (theme pair chosen by `options.darkMode ?? (configuration.uiMode night flag)`); package cells clickable with selected-state background; purchase via the existing purchase API (LOCATE the activity-based purchase entry in Rovenue.kt; resolve activity from context, onPurchaseFailed with a clear error when the context has none); auto logPaywallShown on first `onAttachedToWindow`; restore hidden when handler null; bind() with null builderConfigJson clears to empty.

- [x] **Step 1:** implement with logic extracted into testable pure functions where possible (style computation, action routing). **Step 2:** `./gradlew testDebugUnitTest` green + `./gradlew assembleRelease` (or the module's compile task) green. **Step 3:** Commit: `feat(sdk-kotlin): native Android Views renderer for builder paywalls`.

---

### Task 7: Docs + checkoff

**Files:**
- Modify: `apps/docs/content/docs/guides/placements-and-paywalls.mdx` — update the Phase-C Callout: native rendering NOW AVAILABLE; add Swift/Kotlin tabs showing `RovenuePaywallView` usage (verify exact signatures against the shipped code; RN = DTO passthrough only, presentation bridge coming)
- Modify: `CLAUDE.md` placements line — "native renderers (SwiftUI + Android Views) read the same schema"
- Modify: this plan — check off tasks; Verification section stays

- [x] **Step 1:** write + `pnpm --filter docs build` green. **Step 2:** Commit: `docs: native builder-paywall rendering guide`.

---

## Verification (after all tasks)

- [x] `pnpm build --force` — 9/9 green; `@rovenue/shared` 267/267 (2026-07-22)
- [x] `cargo test` 31 suites ok + `fmt --check` + `clippy -D warnings` clean; bindings regen clean, none committed
- [x] `swift test` — All tests passed (incl. 32 decoder/helper + render-support tests)
- [x] `./gradlew testDebugUnitTest` — 154 tests green (+ `assembleRelease`)
- [x] RN vitest 157/157 + tsc clean (DTO passthrough)
- [ ] Manual smoke (simulator/device — headless-blocked): present RovenuePaywallView from a placement with a builder paywall on both platforms; recommended alongside the RN-presentation follow-up session
