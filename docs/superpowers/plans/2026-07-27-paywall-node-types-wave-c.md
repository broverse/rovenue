# Paywall Node Types Wave C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make paywall content scrollable on all three renderers, then add `stickyFooter` and `countdown` — the two node types that behave rather than merely draw.

**Architecture:** Scrolling lands first, as one task across all three renderers, because it is the same behaviour three ways and the failure mode is a silent layout change. `stickyFooter` is a node type the renderer hoists out of the scroller; `countdown` is the first node whose output changes with time, so its timer is bound to the view's lifecycle on every platform.

**Tech Stack:** TypeScript + Zod, React, SwiftUI (`ScrollView` + `GeometryReader`), Android Views (`NestedScrollView`), Vitest, `swift test`, `testDebugUnitTest`.

**Spec:** `docs/superpowers/specs/2026-07-27-paywall-node-types-wave-c-design.md`

## Global Constraints

These five are binding, and each was written from a defect that actually shipped in an earlier wave.

1. **A node type's obligations are discharged in one task** — `OVERRIDABLE_PROP_KEYS`, `LOCALIZED_KEYS`, every per-type dispatcher, and the inspector fields those override keys imply. Wave A declared override keys in one task and left the UI to another, and shipped a labelled override control containing no inputs.
2. **No `default` branch in a TypeScript per-type dispatcher.** Use an exhaustiveness check that fails to compile when a type is missing. That `default: return null` is what let the above reach users.
3. **Every optional prop's absent-value behaviour is decided once**, in `packages/shared/src/paywall/schema.ts`, or is explicitly *inherit*. Wave A left it per renderer and an uncoloured divider drew three different ways.
4. **The three renderers are reviewed together, in one review.** Both Criticals in wave A and both in wave B came from that comparison; none would have surfaced task-scoped.
5. **A rule verified by reading code is not a verified outcome.** In wave B the Kotlin honoured "never substitute a colour for an absent prop" exactly — it never called `imageTintList` — and Android still drew white marks, because the substituted value had moved into the vendored asset. Where a rule governs what the user sees, the check must reach the rendered result.

Rule 5 binds this wave hardest: scroll fill, footer padding and timer lifecycle are all invisible to the tests this repo can run.

Also in force:

- **Never create or switch branches, and never use a worktree.** Commit on whatever HEAD is checked out.
- **`git add` only the files your task touches.** Never `git add -A`. After committing run `git show --stat <sha>` and confirm it holds exactly your files. Report the SHA you verified.
- No magic values.
- **`apps/dashboard` has 10 pre-existing failures** unrelated to this work. Record the count before you start and confirm it is unchanged; if it moves, the difference is yours.

### Baselines

`packages/shared` 588 · `packages/paywall-renderer` 69 · `packages/sdk-swift` 200 · `packages/sdk-kotlin` 256 · `apps/dashboard` 635 passing / 10 failing.

### Defaults, declared once

| Constant | Value | Applies to |
|---|---|---|
| `COUNTDOWN_DEFAULT_ON_EXPIRY` | `"freeze"` | a countdown with no `onExpiry` |
| `COUNTDOWN_TICK_MS` | `1000` | the tick interval, all three platforms |
| `STICKY_FOOTER_DEFAULT_BACKGROUND` | `{ light: "#FFFFFF", dark: "#111827" }` | a footer with no `background` |

A countdown's absent `color` **inherits** the ambient text colour — expressed as the absence of a colour instruction, never a substituted value.

---

## File Structure

**Modified:** `packages/shared/src/paywall/{schema.ts,validate.ts,render-fixtures.json}` and tests; `packages/paywall-renderer/src/{renderer.tsx,nodes.tsx}` and tests; `packages/sdk-swift/Sources/Rovenue/PaywallUI/{BuilderConfigModel.swift,RovenuePaywallView.swift,PaywallOverrides.swift}` and tests; `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/{BuilderConfigModel.kt,NodeViewFactory.kt,PaywallOverrides.kt,RovenuePaywallView.kt}` and tests; `apps/dashboard/src/components/paywall-builder/**` and `apps/dashboard/src/i18n/locales/en.json`.

Task 1 first. **Task 2 before tasks 4–6**, because the footer is hoisted out of the scroller Task 2 creates. Task 3 is independent of 2. Tasks 4–6 are independent of one another and are **reviewed together**.

---

### Task 1: Both node types in the shared schema, with all shared obligations

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts`, `packages/shared/src/paywall/validate.ts`, `packages/shared/src/paywall/render-fixtures.json`
- Test: `packages/shared/src/paywall/{schema.test.ts,validate.test.ts,render-fixtures.test.ts}`

**Interfaces:**
- Produces: `StickyFooterNode`, `CountdownNode`; the three constants above; `OVERRIDABLE_PROP_KEYS` and `LOCALIZED_KEYS` rows; the issue codes `STICKY_FOOTER_NOT_AT_ROOT`, `MULTIPLE_STICKY_FOOTERS`, `COUNTDOWN_NO_DEADLINE`, `COUNTDOWN_DEADLINE_PAST`.

- [ ] **Step 1: Write the failing schema tests**

```ts
describe("wave C node types", () => {
  const wrap = (node: unknown) => ({
    formatVersion: 2, defaultLocale: "en", localizations: { en: {} },
    root: { type: "stack", id: "root", axis: "v", children: [node] },
  });

  it("accepts a stickyFooter with children", () => {
    expect(builderConfigSchema.safeParse(wrap({
      type: "stickyFooter", id: "sf", children: [{ type: "spacer", id: "s1", size: 8 }],
    })).success).toBe(true);
  });

  it("accepts a countdown with an absolute deadline", () => {
    expect(builderConfigSchema.safeParse(wrap({
      type: "countdown", id: "c1", endsAt: "2027-01-01T00:00:00.000Z",
    })).success).toBe(true);
  });

  it("accepts a countdown with a duration", () => {
    expect(builderConfigSchema.safeParse(wrap({
      type: "countdown", id: "c1", durationSeconds: 900,
    })).success).toBe(true);
  });

  // Exactly one deadline source. Both is ambiguous, and ambiguity in a
  // wire format outlives whoever wrote it.
  it("rejects a countdown carrying BOTH deadline forms", () => {
    expect(builderConfigSchema.safeParse(wrap({
      type: "countdown", id: "c1", endsAt: "2027-01-01T00:00:00.000Z", durationSeconds: 900,
    })).success).toBe(false);
  });

  // Neither PARSES — an author mid-edit must still save. It is the
  // validator that refuses the publish.
  it("accepts a countdown with neither, so it can still be saved", () => {
    expect(builderConfigSchema.safeParse(wrap({ type: "countdown", id: "c1" })).success).toBe(true);
  });

  it("rejects a non-ISO endsAt", () => {
    expect(builderConfigSchema.safeParse(wrap({
      type: "countdown", id: "c1", endsAt: "next tuesday",
    })).success).toBe(false);
  });

  it("gives both types an OVERRIDABLE_PROP_KEYS row", () => {
    expect(OVERRIDABLE_PROP_KEYS.stickyFooter).toEqual(["background"]);
    expect(OVERRIDABLE_PROP_KEYS.countdown).toEqual(["color"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/paywall/schema.test.ts`
Expected: FAIL — neither type is in the union.

- [ ] **Step 3: Constants and types**

In `schema.ts`, beside the wave B constants:

```ts
/** A countdown past its deadline holds at zero rather than vanishing —
 *  hiding it collapses whatever space it occupied, which is a layout jump
 *  as the out-of-the-box behaviour. */
export const COUNTDOWN_DEFAULT_ON_EXPIRY = "freeze" as const;
/** Tick interval, identical on all three platforms. */
export const COUNTDOWN_TICK_MS = 1000;
export const STICKY_FOOTER_DEFAULT_BACKGROUND = { light: "#FFFFFF", dark: "#111827" } as const;

export type StickyFooterNode = {
  type: "stickyFooter";
  id: string;
  children: PaywallNode[];
  /** Absent = STICKY_FOOTER_DEFAULT_BACKGROUND. A pinned bar needs an
   *  opaque background or the content scrolls visibly beneath it. */
  background?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type CountdownNode = {
  type: "countdown";
  id: string;
  /** ISO-8601 absolute deadline. Mutually exclusive with durationSeconds. */
  endsAt?: string;
  /** Seconds from this paywall's first show to this user, persisted.
   *  Mutually exclusive with endsAt. */
  durationSeconds?: number;
  /** Absent = COUNTDOWN_DEFAULT_ON_EXPIRY. */
  onExpiry?: "freeze" | "hide";
  labelKey?: string;
  /** Absent = inherit the ambient text colour. */
  color?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

Add both to the `PaywallNode` union.

- [ ] **Step 4: Schemas, exclusivity, and the override rows**

```ts
const stickyFooterNodeSchema: z.ZodType<StickyFooterNode> = z.object({
  type: z.literal("stickyFooter"),
  id: z.string().min(1),
  children: z.lazy(() => z.array(lazyPaywallNodeSchema)),
  background: themeColorSchema.optional(),
  overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.stickyFooter).optional(),
  fallback: lazyPaywallNodeSchema.optional(),
  visibility: nodeVisibilitySchema.optional(),
});

const countdownNodeSchema: z.ZodType<CountdownNode> = z
  .object({
    type: z.literal("countdown"),
    id: z.string().min(1),
    endsAt: z.string().datetime().optional(),
    durationSeconds: z.number().positive().optional(),
    onExpiry: z.enum(["freeze", "hide"]).optional(),
    labelKey: z.string().min(1).optional(),
    color: themeColorSchema.optional(),
    overrides: overridesArraySchema(OVERRIDABLE_PROP_KEYS.countdown).optional(),
    fallback: lazyPaywallNodeSchema.optional(),
    visibility: nodeVisibilitySchema.optional(),
  })
  // Both is ambiguous; NEITHER is allowed so a half-authored node still
  // saves — the validator blocks the publish instead.
  .refine((n) => !(n.endsAt !== undefined && n.durationSeconds !== undefined), {
    message: "endsAt and durationSeconds are mutually exclusive",
  });
```

Add both to the `paywallNodeSchema` union and these rows to `OVERRIDABLE_PROP_KEYS`:

```ts
  stickyFooter: ["background"],
  countdown: ["color"],
```

- [ ] **Step 5: `LOCALIZED_KEYS` rows**

```ts
  stickyFooter: () => [],
  countdown: (n) => (n.labelKey ? [n.labelKey] : []),
```

`stickyFooter` returns none of its own — its children are walked separately, exactly as `stack`'s are.

- [ ] **Step 6: The four issue codes**

Add all four to `BuilderIssue["code"]` and to `ISSUE_SEVERITY`:

```ts
  // Renders inline instead of pinned — degraded, not broken.
  STICKY_FOOTER_NOT_AT_ROOT: "warning",
  MULTIPLE_STICKY_FOOTERS: "warning",
  // Cannot render at all, so it must not ship — but it must still save,
  // because "I have not chosen the deadline yet" is a normal edit state.
  COUNTDOWN_NO_DEADLINE: "publish",
  // The author's dated promotion has already passed.
  COUNTDOWN_DEADLINE_PAST: "warning",
```

Emit them in the existing node walk. `STICKY_FOOTER_NOT_AT_ROOT` needs to know whether the node is a direct child of `config.root`; compute that set once before the walk rather than threading a depth parameter through it. `COUNTDOWN_DEADLINE_PAST` compares `endsAt` against the current time — take the clock as an injectable parameter defaulting to `Date.now`, so the test does not depend on the wall clock.

Add tests for all four, and assert the tier of each: the three warnings block neither gate, and `COUNTDOWN_NO_DEADLINE` blocks publish but **not** save.

- [ ] **Step 7: Extend `render-fixtures.json`**

Add `stickyFooter` and `countdown` entries to `accept`. The coverage test added in wave B derives its type list programmatically, so it will fail until both are present — that is the mechanism working.

- [ ] **Step 8: Run, and mutation-check the exclusivity**

Run: `cd packages/shared && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. Baseline 588.

Then delete the `.refine(...)` and re-run: the "rejects both deadline forms" test must FAIL. Restore, confirm green, report both.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/paywall
git commit -m "feat(shared): add the stickyFooter and countdown node types"
```

---

### Task 2: Scrollable content on all three renderers

**Files:**
- Modify: `packages/paywall-renderer/src/renderer.tsx`; `packages/sdk-swift/Sources/Rovenue/PaywallUI/RovenuePaywallView.swift`; `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/RovenuePaywallView.kt`
- Test: each package's renderer test

**Interfaces:**
- Produces: a scroll container at each renderer's root, into which Task 4–6's `stickyFooter` will *not* be placed.

This is one task across three packages on purpose. It is the same behaviour expressed three ways, and the failure mode — content that stops filling the screen — is identical everywhere. Split across three tasks it would get three interpretations.

**No renderer scrolls today.** There is no `overflow` in the web renderer, no `ScrollView` in SwiftUI, no `NestedScrollView` on Android. A paywall taller than the screen currently has unreachable content, purchase button included. This task is a bug fix before it is a prerequisite.

- [ ] **Step 1: Write the failing tests**

Web, in `renderer.test.tsx`:

```tsx
it("puts the content in a scroller that still fills the viewport", () => {
  const { container } = render(<PaywallRenderer config={shortConfig} {...base} />);
  const scroller = container.querySelector("[data-rov-paywall-scroll]") as HTMLElement;
  expect(scroller).not.toBeNull();
  expect(scroller.style.overflowY).toBe("auto");
  const inner = container.querySelector("[data-rov-paywall-content]") as HTMLElement;
  // The trap: without a viewport minimum the stack stops filling and any
  // paywall pushing its CTA down with a flexible spacer collapses upward.
  expect(inner.style.minHeight).toBe("100%");
});
```

Swift, in the render-support tests: assert the body's type description contains `ScrollView`, via `String(describing: type(of: view.body))`. **This is the weakest test in the plan** — it pins that a ScrollView is composed in, not that the viewport-minimum works — because SwiftUI views are not inspectable without a dependency this package does not carry. Its real check is smoke item 1. Write it anyway: it catches the ScrollView being removed outright, which is the coarser regression.

Kotlin, in `RovenuePaywallViewTest` (create it if absent): after `bind`, assert the direct child of the view is a `NestedScrollView` and that `isFillViewport` is `true`.

- [ ] **Step 2: Run all three to verify failure**

Run each package's suite. Expected: FAIL — no scroll container anywhere.

- [ ] **Step 3: Web**

`PaywallRenderer` currently returns a single `<div data-rov-paywall-root>` wrapping `renderNode(config.root, ctx)`. Split it into a scroller and an inner content box:

```tsx
  return (
    <div
      data-rov-paywall-root=""
      style={{
        backgroundColor: resolveThemeColor(config.background, colorScheme),
        boxSizing: "border-box",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div data-rov-paywall-scroll="" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {/* minHeight 100% is what keeps a short paywall filling the screen;
            without it a flexible spacer collapses and the CTA rides up. */}
        <div data-rov-paywall-content="" style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
          {renderNode(config.root, ctx)}
        </div>
      </div>
    </div>
  );
```

- [ ] **Step 4: SwiftUI**

Wrap the root content in a `GeometryReader` + `ScrollView`, giving the content a minimum height of the proxy's height:

```swift
GeometryReader { proxy in
    ScrollView {
        rootContent(config, ctx)
            .frame(minHeight: proxy.size.height, alignment: .top)
    }
}
```

`minHeight` rather than `height`, and `alignment: .top`, so taller content still grows and scrolls.

- [ ] **Step 5: Android**

In `render()`, the root view is currently added directly:

```kotlin
val rootView = NodeViewFactory.build(context, cfg.root, ctx, cell = null) ?: return
addView(rootView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
```

Put it inside a `NestedScrollView`:

```kotlin
val rootView = NodeViewFactory.build(context, cfg.root, ctx, cell = null) ?: return
val scroller = androidx.core.widget.NestedScrollView(context).apply {
    // fillViewport is the Android spelling of "content still fills the
    // screen when it is shorter than the viewport". Without it a stack
    // with a flexible spacer collapses to its natural height.
    isFillViewport = true
    addView(rootView, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
}
addView(scroller, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
```

`NestedScrollView` lives in `androidx.core`. **This module does not declare it** — `build.gradle.kts` lists only `androidx.lifecycle:lifecycle-process` among the androidx entries (verified). Add `androidx.core:core-ktx` alongside it, matching the style of the existing lines. If it turns out to arrive transitively and the build already resolves `NestedScrollView` without the new line, say so and leave the dependency list alone rather than adding a redundant entry.

- [ ] **Step 6: Run all three, then prove the trap is actually guarded**

Run each suite; all three must pass.

Then, on **each** platform in turn, remove the viewport-minimum (web `minHeight`, Swift `.frame(minHeight:)`, Android `isFillViewport`) and re-run. The corresponding test must FAIL. Restore each and confirm green. Report all three results — this is the one change in the wave that no ordinary assertion would catch.

- [ ] **Step 7: Commit**

```bash
git add packages/paywall-renderer/src packages/sdk-swift/Sources packages/sdk-swift/Tests packages/sdk-kotlin/src
git commit -m "fix(paywall): scroll paywall content, keeping short paywalls full-height"
```

---

### Task 3: Author both types in the builder

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/{node-meta.ts,tree-ops.ts,inspector/content-tab.tsx,inspector/style-tab.tsx,inspector/overrides.tsx,inspector/tabs.ts}`, `apps/dashboard/src/i18n/locales/en.json`
- Test: the matching test files

**Interfaces:**
- Consumes: Task 1's types, constants and override keys.

Both override keys — `stickyFooter.background` and `countdown.color` — must render a real input in `overrides.tsx`. Wave A shipped a labelled override control with no inputs because that obligation lived in a different task from the declaration; here they are in the same task.

- [ ] **Step 1: Write the failing tests**

`node-meta.test.ts`'s existing "every node type has an icon and a label" iterates `NODE_TYPES` and will fail once both are added. `tabs.test.ts`'s union-driven "every node type gets at least one tab" likewise.

In `tree-ops.test.ts`:

```ts
it("creates a stickyFooter with no children", () => {
  const node = newNode("stickyFooter", idGen);
  expect(node).toEqual({ type: "stickyFooter", id: node.id, children: [] });
});

it("creates a countdown defaulting to a duration", () => {
  const node = newNode("countdown", idGen);
  expect(node).toEqual({ type: "countdown", id: node.id, durationSeconds: COUNTDOWN_DEFAULT_DURATION_SECONDS });
});
```

In `overrides.test.tsx`, a case per override key asserting a real input renders.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/dashboard && npx vitest run src/components/paywall-builder`

- [ ] **Step 3: Metadata, creation and fields**

`node-meta.ts`: add both to `NODE_TYPES`, `NODE_ICON` (import `PanelBottom` and `Timer` from `lucide-react`) and `NODE_TYPE_LABEL` (`"Sticky footer"`, `"Countdown"`).

`tree-ops.ts`: add the two `case` arms above. Declare `const COUNTDOWN_DEFAULT_DURATION_SECONDS = 900;` at the top — a new countdown starts as a 15-minute session timer because that needs no author input, where an absolute date would start invalid and immediately raise `COUNTDOWN_NO_DEADLINE`.

`content-tab.tsx`: `countdown` gets a deadline-mode radio (absolute / duration) that swaps between a datetime field and a seconds field, an `onExpiry` select, and an optional label-key field. `stickyFooter` has no content fields — its children are edited in the layer tree like any container.

`style-tab.tsx`: `stickyFooter.background` and `countdown.color`, using the existing colour control.

`tabs.ts`: `stickyFooter` → `style` + `visibility`; `countdown` → `content` + `style` + `visibility`.

`overrides.tsx`: cases for `stickyFooter.background` and `countdown.color`.

Add i18n labels under the paths the other types use.

- [ ] **Step 4: Run and prove the override guard**

Run: `cd apps/dashboard && npx vitest run`. Failures must still be exactly 10.

Then `git stash` only `overrides.tsx`, re-run `inspector/overrides.test.tsx`, confirm the two new cases FAIL, restore, confirm green. Report both.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): author stickyFooter and countdown nodes"
```

---

### Task 4: Web renderer — `stickyFooter` and `countdown`

**Files:**
- Modify: `packages/paywall-renderer/src/{renderer.tsx,nodes.tsx}`
- Test: `packages/paywall-renderer/src/renderer.test.tsx`

**Interfaces:**
- Consumes: Task 1's types and constants; Task 2's `data-rov-paywall-scroll` / `data-rov-paywall-content` structure.

- [ ] **Step 1: Write the failing tests**

```tsx
it("pins a root-level stickyFooter outside the scroller", () => {
  const { container } = render(<PaywallRenderer config={cfgWithFooter} {...base} />);
  const scroller = container.querySelector("[data-rov-paywall-scroll]")!;
  expect(scroller.querySelector('[data-rov-node="sf"]')).toBeNull();
  expect(container.querySelector('[data-rov-sticky-footer]')).not.toBeNull();
});

it("gives the scrolled content bottom padding so the footer never covers it", () => {
  const { container } = render(<PaywallRenderer config={cfgWithFooter} {...base} />);
  const inner = container.querySelector("[data-rov-paywall-content]") as HTMLElement;
  expect(inner.style.paddingBottom).not.toBe("");
});

it("renders a nested stickyFooter inline instead of pinning it", () => {
  const { container } = render(<PaywallRenderer config={cfgWithNestedFooter} {...base} />);
  const scroller = container.querySelector("[data-rov-paywall-scroll]")!;
  expect(scroller.querySelector('[data-rov-node="sf"]')).not.toBeNull();
});

it("formats the remaining time and freezes at zero", () => {
  const { container } = render(
    <PaywallRenderer config={cfgCountdown("2027-01-01T00:00:00.000Z")} {...base} now={new Date("2026-12-31T23:59:00.000Z")} />,
  );
  expect(container.querySelector('[data-rov-node="c1"]')!.textContent).toContain("01:00");
});

it("removes a countdown whose onExpiry is hide once it has passed", () => {
  const { container } = render(
    <PaywallRenderer config={cfgCountdown("2026-01-01T00:00:00.000Z", "hide")} {...base} now={new Date("2027-01-01T00:00:00.000Z")} />,
  );
  expect(container.querySelector('[data-rov-node="c1"]')).toBeNull();
});
```

The countdown tests need a fixed clock. Add an optional `now?: Date` prop to `PaywallRendererProps` defaulting to `new Date()` — a renderer whose output depends on the wall clock is otherwise untestable, and the same injection point serves the dashboard's canvas preview.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/paywall-renderer && npx vitest run`

- [ ] **Step 3: Implement**

In `renderer.tsx`, before rendering, partition `config.root.children` into the last direct-child `stickyFooter` and everything else. Render the rest inside the content box, and the footer as a sibling of the scroller with `flexShrink: 0`, `background` resolved from `STICKY_FOOTER_DEFAULT_BACKGROUND` when absent, and `paddingBottom: env(safe-area-inset-bottom)`. Give the content box a `paddingBottom` so the last item clears the footer.

A `stickyFooter` reached anywhere else goes through the normal dispatcher and renders like a stack — add its `case` in `nodes.tsx` accordingly.

`countdown`: compute remaining from `endsAt` or from `durationSeconds` plus a first-show timestamp, tick with `setInterval` at `COUNTDOWN_TICK_MS` inside a `useEffect` that **clears on unmount**, and render `hh:mm:ss` (dropping the hours segment when zero). `onExpiry === "hide"` returns `null` past the deadline; `"freeze"` holds at `00:00`. An absent `color` emits no colour.

- [ ] **Step 4: Run and mutation-check**

Run the suite; expected PASS.

Then remove the content box's `paddingBottom` and re-run: the padding test must FAIL. Restore. Report it.

- [ ] **Step 5: Commit**

```bash
git add packages/paywall-renderer/src
git commit -m "feat(paywall-renderer): pin stickyFooter and tick countdown"
```

---

### Task 5: SwiftUI renderer — `stickyFooter` and `countdown`

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/{BuilderConfigModel.swift,RovenuePaywallView.swift,PaywallOverrides.swift}`
- Test: `packages/sdk-swift/Tests/RovenueTests/BuilderConfigModelTests.swift`

**Interfaces:**
- Consumes: Task 1's wire shape; Task 2's `ScrollView` + `GeometryReader` root.

`PaywallOverrides.swift` is in the list because its `BuilderNode` dispatch is an exhaustive `switch` with no `default` — the two new cases are required to compile. This has happened in both previous waves; it is expected.

- [ ] **Step 1: Write the failing decode tests**

```swift
func test_decodesStickyFooterChildren() throws {
    let node = try firstChild(#"{"type":"stickyFooter","id":"sf","children":[{"type":"spacer","id":"s1","size":8}]}"#)
    guard case .stickyFooter(let p) = node else { XCTFail("not a stickyFooter"); return }
    XCTAssertEqual(p.children.count, 1)
}

func test_decodesCountdownBothModes() throws {
    let abs = try firstChild(#"{"type":"countdown","id":"c1","endsAt":"2027-01-01T00:00:00Z"}"#)
    guard case .countdown(let a) = abs else { XCTFail("not a countdown"); return }
    XCTAssertEqual(a.endsAt, "2027-01-01T00:00:00Z")
    let dur = try firstChild(#"{"type":"countdown","id":"c2","durationSeconds":900}"#)
    guard case .countdown(let d) = dur else { XCTFail("not a countdown"); return }
    XCTAssertEqual(d.durationSeconds, 900)
}

// The formatter is where a countdown is actually testable — SwiftUI views
// are not inspectable here, so extract it as a pure function.
func test_formatsRemainingTime() {
    XCTAssertEqual(countdownText(remaining: 60), "01:00")
    XCTAssertEqual(countdownText(remaining: 3661), "01:01:01")
    XCTAssertEqual(countdownText(remaining: 0), "00:00")
    XCTAssertEqual(countdownText(remaining: -5), "00:00")
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sdk-swift && swift test`

- [ ] **Step 3: Model, override, render**

Add `StickyFooterProps` and `CountdownProps` beside the wave B structs, the two enum cases and type-switch arms, and matching `applyOverrides` overloads.

Extract `countdownText(remaining: Int) -> String` as an internal free function — it is the only part of a countdown a unit test in this package can reach, so it must not live inside the view.

Render: the sticky footer is pinned by the root, not by the node case, so `RovenuePaywallView` partitions `config.root.children` the same way the web renderer does and places the footer below the `ScrollView` with `.padding(.bottom)` for the safe area; a `stickyFooter` found anywhere else renders as a plain `VStack`. The scrolled content's bottom inset must come from the footer's MEASURED height, not a constant — a footer with a CTA plus fine print is routinely taller than one with a CTA alone, and a fixed value leaves the last item unreachable, which is the same failure as having no scrolling at all.

The countdown uses a `Timer.publish(every:)` at `COUNTDOWN_TICK_MS / 1000` seconds, `.autoconnect()`, and **`.onDisappear` cancelling it**. An absent `color` passes `nil` to `.foregroundColor`.

**`durationSeconds` must be anchored to a PERSISTED first-show instant**, keyed by paywall identifier, in `UserDefaults`. The spec requires "first show per user, persisted", and warns that a timer restarting on every open is not a deadline. The web renderer cannot do this — it is a pure component with no storage — so it takes an injected `firstShownAt` and falls back to mount time. This SDK *has* storage, so it owns the real thing: on first render of a countdown for a given paywall, write the instant if absent, then always read it back. Add a test that a second render with the same paywall identifier reuses the stored anchor rather than re-stamping it.

- [ ] **Step 4: Run**

Run: `cd packages/sdk-swift && swift test`. Baseline 200.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources packages/sdk-swift/Tests
git commit -m "feat(sdk-swift): pin stickyFooter and tick countdown"
```

---

### Task 6: Android renderer — `stickyFooter` and `countdown`

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/{BuilderConfigModel.kt,NodeViewFactory.kt,PaywallOverrides.kt,RovenuePaywallView.kt}`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/{BuilderConfigModelTest.kt,NodeViewFactoryTest.kt}`

**Interfaces:**
- Consumes: Task 1's wire shape; Task 2's `NestedScrollView` root.

`PaywallOverrides.kt`'s `when` over `BuilderNode` is exhaustive with no `else` — the two cases are required to compile.

- [ ] **Step 1: Write the failing tests**

```kotlin
@Test
fun decodesStickyFooterChildren() {
    val node = firstChild(rootWith("""{"type":"stickyFooter","id":"sf","children":[{"type":"spacer","id":"s1","size":8}]}"""))
    assertTrue(node is BuilderNode.StickyFooter)
    assertEquals(1, (node as BuilderNode.StickyFooter).children.size)
}

@Test
fun decodesCountdownBothModes() {
    val abs = firstChild(rootWith("""{"type":"countdown","id":"c1","endsAt":"2027-01-01T00:00:00Z"}"""))
    assertEquals("2027-01-01T00:00:00Z", (abs as BuilderNode.Countdown).endsAt)
    val dur = firstChild(rootWith("""{"type":"countdown","id":"c2","durationSeconds":900}"""))
    assertEquals(900.0, (dur as BuilderNode.Countdown).durationSeconds)
}

@Test
fun formatsRemainingTime() {
    assertEquals("01:00", countdownText(60))
    assertEquals("01:01:01", countdownText(3661))
    assertEquals("00:00", countdownText(0))
    assertEquals("00:00", countdownText(-5))
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`

- [ ] **Step 3: Model, override, render**

Add the two data classes, parser arms, override-props objects and `PaywallOverrides.kt` cases. Extract `countdownText(remaining: Long): String` as an internal top-level function so it is unit-testable — the view itself is not.

`RovenuePaywallView.render()` partitions `cfg.root.children` the same way the other two renderers do: the last direct-child sticky footer is added **below** the `NestedScrollView` in the outer container, with bottom padding for the navigation bar inset; everything else stays inside the scroller. The scroller's bottom padding must come from the footer's MEASURED height, not a constant — a footer with a CTA plus fine print is routinely taller than one with a CTA alone, and a fixed value leaves the last item unreachable, which is the same failure as having no scrolling at all. A `stickyFooter` found deeper renders as a plain `LinearLayout` via `NodeViewFactory`.

The countdown ticks with a `Handler(Looper.getMainLooper())` posting at `COUNTDOWN_TICK_MS`, started in `onAttachedToWindow` and **removed in `onDetachedFromWindow`** — a handler that outlives the view leaks it. An absent `color` must not call `setTextColor`, so the text inherits.

**`durationSeconds` must be anchored to a PERSISTED first-show instant**, keyed by paywall identifier, in `SharedPreferences`. The spec requires "first show per user, persisted", and warns that a timer restarting on every open is not a deadline. The web renderer cannot do this — it is a pure component with no storage — so it takes an injected `firstShownAt` and falls back to mount time. This SDK *has* storage, so it owns the real thing: on first render of a countdown for a given paywall, write the instant if absent, then always read it back. Add a test that a second render with the same paywall identifier reuses the stored anchor rather than re-stamping it.

- [ ] **Step 4: Run**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`. Baseline 256, counted from `build/test-results/testDebugUnitTest/*.xml`.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src
git commit -m "feat(sdk-kotlin): pin stickyFooter and tick countdown"
```

---

### Task 7: Device smoke session

**Files:** none — this task produces a written result.

> **This cannot be done by an agent.** It needs a host app on a device or simulator. If you are an agent executing this plan, stop here and hand back with the checklist below.

Three of this wave's behaviours are invisible to every test this repo can run, and rule 5 exists because a rule verified by reading code is not a verified outcome.

- [ ] **Step 1: Record the React Native architecture** the host app runs — old architecture and Fabric take different Expo paths, so every other result is conditional on it.

- [ ] **Step 2: Run on iOS and again on Android**

1. **A short paywall still fills the screen.** One whose CTA is pushed down by a flexible spacer must still sit at the bottom, not ride up to the top. This is the wave's highest-risk change and no assertion catches it.
2. **A long paywall scrolls**, and its last element is reachable.
3. **The sticky footer stays pinned** while content scrolls beneath it.
4. **The last scrolled item is not hidden** behind the footer at the bottom of the scroll.
5. **The footer clears the home indicator** on iOS and the navigation bar on Android.
6. **A nested sticky footer renders inline**, not pinned.
7. **The countdown ticks** once per second and the digits are stable — no flicker, no drift over a full minute.
8. **The timer stops when backgrounded** and resumes on return. Leave the app backgrounded for a minute and confirm the countdown shows the correctly elapsed time, not a frozen one.
9. **`onExpiry: "freeze"` holds at 00:00**; `"hide"` removes the node and the layout settles without a jump mid-scroll.
10. **A duration countdown does not restart** when the paywall is closed and reopened.

- [ ] **Step 3: Record the outcome** under an `RN WAVE C SMOKE` heading in this plan's SDD workspace ledger, one line per item per platform.

---

## Notes for the executor

- Task 1 first; **Task 2 before Tasks 4–6**. Task 3 is independent of Task 2.
- **Review Tasks 4–6 together, in one review, not three.** Both Criticals in wave A and both in wave B came from reading the platforms against each other.
- Tasks 1, 2, 3 and 4 carry mutation checks. Task 2's is the most important in the wave: remove the viewport minimum on each platform and confirm the corresponding test fails. A guard that cannot fail guards nothing, and this is the one change no ordinary assertion would notice.
