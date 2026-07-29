# Node Style Pass — border / background / text-color across the builder

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Sequential tasks; every commit leaves main green.

**Goal:** Close the styling gap the builder's nodes have today: no border support anywhere, buttons locked to three variants (no custom background / label color / corner radius / border), text nodes cannot form badges (no background/radius). Additive, theme-aware, rendered identically on all three platforms.

**Design (the whole gap, nothing more):**

- New shared type `NodeBorder = { width: number; color: ThemeColor }` (both fields required inside the optional prop — a border without width or color renders nothing and confuses every decoder).
- Prop matrix (all optional, additive):
  - `StackNode`: + `border`
  - `TextNode`: + `background`, `cornerRadius`
  - `ImageNode`: + `border`
  - `ButtonNode` + `PurchaseButtonNode`: + `background`, `labelColor`, `border`, `cornerRadius` (custom props override the variant's own colors; variant remains the base)
- Overridable-keys table (`schema.ts` ~:418) gains the new keys per type (override parity is a hard requirement on ALL platforms — the P6 lesson).
- Rendering semantics (identical everywhere): border drawn INSIDE the corner radius (web `border` + `borderRadius`; SwiftUI `overlay(RoundedRectangle().stroke)`; Android `GradientDrawable` stroke); `labelColor` beats the variant's label color; `background` beats the variant's fill; absent props = today's output byte-identical.
- Dark scheme via existing `ThemeColor` resolution idiom on each platform.

**Tech Stack:** packages/shared (Zod schema + types), packages/paywall-renderer (web), apps/dashboard inspector style-tab, packages/sdk-swift SwiftUI PaywallUI, packages/sdk-kotlin paywallui, `render-fixtures.json` (3-platform contract — LAST, so every intermediate commit stays green).

## Global Constraints

- Current branch (main); no branch/worktree; sequential dispatch; stage ONLY your own files; never bare `git stash`. Foreign dirty files (fonts wave) untouched.
- Additive only: a config without the new props must render byte-identical to today on every platform (regression pin in each renderer task).
- Named constants for literals; static-literal t() keys + en.json same-task; TDD with RED evidence per task.
- Verify commands: shared/dashboard `vitest` + `tsc`; web renderer package tests; `cd packages/sdk-swift && swift test`; `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`.
- render-fixtures.json is edited ONLY in Task 6 (all three renderers must already support the props, so fixture tests stay green on every platform).

### Task 1: Shared contract — schema types + Zod + overridable keys

`packages/shared/src/paywall/schema.ts`: `NodeBorder` type + `nodeBorderSchema`; add props per the matrix; extend the per-type overridable-keys table; extend `emptyBuilderConfig`-adjacent helpers only if they enumerate props. Tests: schema round-trip of each new prop, rejection of malformed border (missing width/color), overridable-keys inclusion. Verify shared vitest + tsc, plus api/dashboard tsc (downstream inference). Commit `feat(shared): node border/background/labelColor style contract`.

### Task 2: Web renderer

`packages/paywall-renderer`: apply the matrix in styles/nodes (border inside radius; button custom props override variant; text bg+radius). Regression pin: existing fixture suite untouched and green (no fixture edits here). New unit tests for the style resolution helpers. Commit `feat(paywall-renderer): render node border/background/labelColor`.

### Task 3: Inspector UI

`apps/dashboard` style-tab: a reusable `BorderField` composite (width NumberField + ThemeColorField, collapses to undefined when cleared); background/labelColor/cornerRadius fields on the node types per matrix; overrides panel parity (the overrides editor lists the new keys). i18n keys + en.json. Tests per style-tab idiom. Commit `feat(dashboard): style controls for border/background/label color`.

### Task 4: SwiftUI renderer

`packages/sdk-swift` PaywallUI node rendering: matrix + override parity; no charge-path/preview files touched. `swift test` green (pin: prop-absent snapshot behavior unchanged — use the existing render-model unit-test idiom, SwiftUI body isn't snapshot-tested here). Commit `feat(sdk-swift): node border/background/labelColor rendering`.

### Task 5: Android renderer

`packages/sdk-kotlin` paywallui NodeViewFactory: matrix + override parity (GradientDrawable stroke/fill/radius; label color on button text views). `testDebugUnitTest` green. Commit `feat(sdk-kotlin): node border/background/labelColor rendering`.

### Task 6: Fixtures — the 3-platform gate

Extend `render-fixtures.json` with cases: stack+border, text badge (bg+radius), button full-custom (bg+labelColor+border+radius), purchaseButton custom, image+border, an override flipping a border color, absent-props regression case. All three platforms' fixture suites + web suite green. Commit `test(paywall): render fixtures for the node style pass`.

## Final verification (controller)

- shared/dashboard/renderer vitest + tsc; `swift test`; `testDebugUnitTest`; whole-feature review focused on: cross-platform visual parity of the matrix, override parity, additive regression pins, and that Task 6's fixtures actually exercise every new prop on every platform.
