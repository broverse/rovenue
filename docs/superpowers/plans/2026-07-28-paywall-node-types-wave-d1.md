# Paywall node types wave D1 (`carousel` + image substrate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `carousel` node type — horizontal paging, page dots, optional auto-advance — across the shared schema, the validator, the builder UI and all three renderers, on top of an Android image loader that can survive it.

**Architecture:** `carousel` is an ordinary container node (`children: PaywallNode[]`), so it inherits the existing unknown-type/`fallback` machinery and needs no SDK-rollout gate. Each renderer uses its platform's native paging primitive rather than a hand-rolled scroller: CSS scroll-snap, SwiftUI `TabView(.page)`, and `androidx.viewpager2`. Before any of that, Android's cache-less image loader gets an LRU bitmap cache and downsampling, because the Android renderer rebuilds its whole view tree on every state change and a carousel multiplies that cost by its page count.

**Tech Stack:** TypeScript (strict) + Zod + Vitest; React 19 for the dashboard and web renderer; SwiftUI (iOS 16 floor); Android Views + Kotlin (minSdk 24, JUnit5).

**Spec:** `docs/superpowers/specs/2026-07-28-paywall-node-types-wave-d1-design.md`. Read §5 (the timer lifecycle contract) and §8 (the six binding rules) before starting any task.

## Global Constraints

- **No magic values.** Every literal — intervals, sizes, colours, cache bounds, dot dimensions — is a named constant. Cross-platform values live in `packages/shared/src/paywall/schema.ts` and are mirrored by hand into Swift and Kotlin; mirror the VALUE, never re-decide it.
- Absent-prop behaviour is either a named shared constant or explicitly **"inherit"**. `indicatorColor` absent **inherits the ambient text ink — expressed as the absence of a colour instruction, never a substituted value.**
- `CAROUSEL_DEFAULT_SHOWS_INDICATOR = true`; `CAROUSEL_DEFAULT_LOOP = false`; `CAROUSEL_MIN_AUTO_ADVANCE_SECONDS = 2`; `IMAGE_CACHE_MAX_ENTRIES = 32`.
- `autoAdvanceSeconds` absent means **off** — not a default interval.
- With `loop: false`, auto-advance **stops permanently on the last page** and does not rewind. With `loop: true` it wraps to the first.
- The timer lifecycle contract (spec §5) binds every time-driven node: off-screen pauses, on-screen resumes without needing a full re-render, nothing outlives the view, and the tick is a repaint trigger — never the source of truth.
- **No `default` branch in a TypeScript per-type dispatcher.** Use `const exhaustive: never = node`.
- `render-fixtures.json` is the **three**-platform decoder contract. Every new `defaults` key needs a by-value comparison in the Swift AND Kotlin sync tests, or it is pinned for web only.
- Never create or switch branches or worktrees; commit on the current branch. `git add` only the files the task touches — never `git add -A`. A parallel agent is working elsewhere in this repo.
- **A test that passes with the feature broken is worse than no test.** Mutation-check every claim; where no test can catch a defect, say so plainly and move it to the smoke checklist.

---

## File Structure

**Shared contract** (Task 1)
- `packages/shared/src/paywall/schema.ts` — `CarouselNode` type, the four constants, `OVERRIDABLE_PROP_KEYS.carousel`, Zod schema
- `packages/shared/src/paywall/validate.ts` — `LOCALIZED_KEYS.carousel`, three issue codes, `walkNodes` recursion into `carousel.children`
- `packages/shared/src/paywall/render-fixtures.json` — accept cases + new `defaults` keys

**Android substrate** (Task 2) — independent of everything else
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/ImageCache.kt` (new) — pure LRU + sample-size logic
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/NodeViewFactory.kt:1328` — `loadImageInto` uses it

**Builder UI** (Task 3)
- `node-meta.ts`, `tree-ops.ts`, `inspector/tabs.ts`, `inspector/content-tab.tsx`, `inspector/style-tab.tsx`, `inspector/overrides.tsx`, `i18n/locales/en.json`

**Renderers** (Tasks 4–6)
- `packages/paywall-renderer/src/nodes.tsx` + `styles.ts`
- `packages/sdk-swift/Sources/Rovenue/PaywallUI/{BuilderConfigModel,RovenuePaywallView,PaywallOverrides}.swift`
- `packages/sdk-kotlin/.../{BuilderConfigModel,NodeViewFactory,RovenuePaywallView}.kt` + `build.gradle.kts`

---

### Task 1: Shared schema, validator and fixture contract

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts`
- Modify: `packages/shared/src/paywall/validate.ts`
- Modify: `packages/shared/src/paywall/render-fixtures.json`
- Test: `packages/shared/src/paywall/schema.test.ts`, `validate.test.ts`, `render-fixtures.test.ts`

**Interfaces:**
- Produces: `CarouselNode`; `CAROUSEL_DEFAULT_SHOWS_INDICATOR`, `CAROUSEL_DEFAULT_LOOP`, `CAROUSEL_MIN_AUTO_ADVANCE_SECONDS` (all exported from `schema.ts`); issue codes `CAROUSEL_EMPTY`, `CAROUSEL_AUTO_ADVANCE_TOO_FAST`, `CAROUSEL_SINGLE_PAGE`.

- [ ] **Step 1: Write the failing schema test**

In `schema.test.ts`:

```ts
it("round-trips a carousel with every optional prop absent", () => {
  const node = { type: "carousel", id: "c1", children: [{ type: "spacer", id: "s1" }] };
  const parsed = paywallNodeSchema.parse(node);
  expect(parsed).toEqual(node);
});

it("rejects a carousel with no children key", () => {
  expect(() => paywallNodeSchema.parse({ type: "carousel", id: "c1" })).toThrow();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/paywall/schema.test.ts`
Expected: FAIL — the union has no `carousel` member.

- [ ] **Step 3: Add the type, constants and Zod member**

In `schema.ts`, beside `StickyFooterNode` (~line 279):

```ts
export type CarouselNode = {
  type: "carousel";
  id: string;
  /** Pages. Any node, not only images — the same freedom `stack` gives. */
  children: PaywallNode[];
  /** Absent = CAROUSEL_DEFAULT_SHOWS_INDICATOR. */
  showsIndicator?: boolean;
  /** Seconds between automatic advances. Absent = no auto-advance at all,
   *  deliberately not a default interval: a paywall that starts moving on
   *  its own without the author asking is a surprise. */
  autoAdvanceSeconds?: number;
  /** Absent = CAROUSEL_DEFAULT_LOOP. */
  loop?: boolean;
  /** Absent = inherit the ambient text colour. */
  indicatorColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

Add `CarouselNode` to the `PaywallNode` union. Beside the other wave constants:

```ts
export const CAROUSEL_DEFAULT_SHOWS_INDICATOR = true;
export const CAROUSEL_DEFAULT_LOOP = false;
/** Below this, dots move faster than a reader can follow. Authoring-time
 *  advice (a `warning`), not a clamp — the renderer honours what it is given. */
export const CAROUSEL_MIN_AUTO_ADVANCE_SECONDS = 2;
```

Add to `OVERRIDABLE_PROP_KEYS` (~line 344): `carousel: ["indicatorColor"],`

The Zod member, beside the `stickyFooter` one:

```ts
carouselNodeSchema = z.object({
  type: z.literal("carousel"),
  id: z.string(),
  children: z.array(z.lazy(() => paywallNodeSchema)),
  showsIndicator: z.boolean().optional(),
  autoAdvanceSeconds: z.number().positive().optional(),
  loop: z.boolean().optional(),
  indicatorColor: themeColorSchema.optional(),
  overrides: z.array(nodeOverrideSchema).optional(),
  fallback: z.lazy(() => paywallNodeSchema).optional(),
  visibility: nodeVisibilitySchema.optional(),
})
```

Match the exact declaration style of the neighbouring node schemas (the file annotates each with an explicit `z.ZodType<T>` because `z.lazy` degrades inference — follow that).

- [ ] **Step 4: Run the schema test**

Run: `cd packages/shared && npx vitest run src/paywall/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing validator tests**

In `validate.test.ts`:

```ts
it("raises CAROUSEL_EMPTY at publish tier for a childless carousel", () => {
  const issues = validateBuilderConfig(configWith({ type: "carousel", id: "c1", children: [] }), "publish");
  expect(issues.map((i) => i.code)).toContain("CAROUSEL_EMPTY");
});

it("raises CAROUSEL_AUTO_ADVANCE_TOO_FAST below the floor", () => {
  const node = { type: "carousel", id: "c1", children: [pageA, pageB], autoAdvanceSeconds: 1 };
  const issues = validateBuilderConfig(configWith(node), "warning");
  expect(issues.map((i) => i.code)).toContain("CAROUSEL_AUTO_ADVANCE_TOO_FAST");
});

it("does NOT raise CAROUSEL_AUTO_ADVANCE_TOO_FAST exactly at the floor", () => {
  const node = {
    type: "carousel", id: "c1", children: [pageA, pageB],
    autoAdvanceSeconds: CAROUSEL_MIN_AUTO_ADVANCE_SECONDS,
  };
  const issues = validateBuilderConfig(configWith(node), "warning");
  expect(issues.map((i) => i.code)).not.toContain("CAROUSEL_AUTO_ADVANCE_TOO_FAST");
});

it("raises CAROUSEL_SINGLE_PAGE for exactly one child", () => {
  const issues = validateBuilderConfig(configWith({ type: "carousel", id: "c1", children: [pageA] }), "warning");
  expect(issues.map((i) => i.code)).toContain("CAROUSEL_SINGLE_PAGE");
});

it("walks INTO carousel children so a nested node's issues surface", () => {
  const nested = { type: "carousel", id: "c1", children: [{ type: "icon", id: "i1", name: "not-a-real-icon" }] };
  const issues = validateBuilderConfig(configWith(nested), "warning");
  expect(issues.map((i) => i.code)).toContain("UNKNOWN_ICON_NAME");
});
```

Use the file's existing `configWith` helper (or its local equivalent) rather than hand-building a `BuilderConfig`.

- [ ] **Step 6: Run them and watch them fail**

Run: `cd packages/shared && npx vitest run src/paywall/validate.test.ts`
Expected: FAIL on all five.

- [ ] **Step 7: Implement the validator changes**

In `validate.ts`:
1. Add the `carousel` row to `LOCALIZED_KEYS`. A carousel has no own localized text, so: `carousel: () => [],`. The mapped type is exhaustive — omitting the row is a compile error, which is the property this design paid for.
2. Make `walkNodes` recurse into `carousel.children` exactly as it does for `stack.children` and `stickyFooter.children`.
3. Raise the three issues.

The tier rule: `CAROUSEL_EMPTY` is `publish` (a carousel with no pages cannot render at all — not a work in progress); the other two are `warning`.

- [ ] **Step 8: Run the validator tests**

Run: `cd packages/shared && npx vitest run src/paywall/validate.test.ts`
Expected: PASS on all five.

- [ ] **Step 9: Widen the fixture contract**

In `render-fixtures.json`, add to `accept` (select by NAME in tests, never by index — a prior wave broke two Kotlin tests that assumed a position):
- `"carousel-bare"` — a carousel with two children and every optional prop absent
- `"carousel-full"` — `showsIndicator: false`, `autoAdvanceSeconds: 5`, `loop: true`, an `indicatorColor`

Add to `defaults`: `CAROUSEL_DEFAULT_SHOWS_INDICATOR: true`, `CAROUSEL_DEFAULT_LOOP: false`, `CAROUSEL_MIN_AUTO_ADVANCE_SECONDS: 2`.

In `render-fixtures.test.ts`, assert the three new `defaults` keys equal the exported constants by value.

- [ ] **Step 10: Run the whole shared suite**

Run: `cd packages/shared && npx vitest run`
Expected: all green (was 623 passing).

- [ ] **Step 11: Mutation-check**

Change `CAROUSEL_MIN_AUTO_ADVANCE_SECONDS` to `1` and confirm the "does NOT raise at the floor" test fails. Restore. Then delete the `carousel` recursion in `walkNodes` and confirm the nested-icon test fails. Restore.

- [ ] **Step 12: Commit**

```bash
git add packages/shared/src/paywall/schema.ts packages/shared/src/paywall/validate.ts \
        packages/shared/src/paywall/render-fixtures.json packages/shared/src/paywall/schema.test.ts \
        packages/shared/src/paywall/validate.test.ts packages/shared/src/paywall/render-fixtures.test.ts
git commit -m "feat(shared): add the carousel node type"
```

---

### Task 2: Android image cache and downsampling

Independent of Task 1 — it touches no shared types. It exists because the Android renderer rebuilds its entire view tree on every state change (`RovenuePaywallView.kt:42-50`, a deliberate documented choice), so `render()` runs on **every package tap**, and today's `loadImageInto` re-fetches and re-decodes at full size each time. A five-page carousel would cost five network fetches per tap.

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/ImageCache.kt`
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/NodeViewFactory.kt:1328` (`loadImageInto`)
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/ImageCacheTest.kt`

**Interfaces:**
- Produces: `internal class BitmapLruCache(maxEntries: Int = IMAGE_CACHE_MAX_ENTRIES)` with `get(url: String): Bitmap?`, `put(url: String, bitmap: Bitmap)`, `size: Int`; and `internal fun sampleSizeFor(sourceWidth: Int, sourceHeight: Int, targetWidth: Int, targetHeight: Int): Int`.

- [ ] **Step 1: Write the failing cache tests**

`ImageCacheTest.kt` — note these must NOT touch `android.graphics.Bitmap`, which is a gutted stub in this module's `android.jar`. Make `BitmapLruCache` generic over its value type (`BitmapLruCache<V>`) so the test can use `String` values, and alias it at the use site. State that reasoning in a comment.

```kotlin
@Test
fun `a second get for the same key does not miss`() {
    val cache = BitmapLruCache<String>(maxEntries = 2)
    cache.put("a", "bitmap-a")
    assertEquals("bitmap-a", cache.get("a"))
}

@Test
fun `evicts the least recently used entry past the bound`() {
    val cache = BitmapLruCache<String>(maxEntries = 2)
    cache.put("a", "A"); cache.put("b", "B")
    cache.get("a")            // "a" is now the most recently used
    cache.put("c", "C")       // evicts "b", not "a"
    assertEquals("A", cache.get("a"))
    assertNull(cache.get("b"))
    assertEquals(2, cache.size)
}

@Test
fun `sampleSizeFor halves until the source fits the target`() {
    assertEquals(1, sampleSizeFor(100, 100, 100, 100))
    assertEquals(2, sampleSizeFor(200, 200, 100, 100))
    assertEquals(4, sampleSizeFor(800, 800, 100, 100))
}

@Test
fun `sampleSizeFor never returns less than one for a zero target`() {
    assertEquals(1, sampleSizeFor(800, 800, 0, 0))
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests '*ImageCacheTest*'`
Expected: FAIL — unresolved reference.

- [ ] **Step 3: Implement `ImageCache.kt`**

```kotlin
package dev.rovenue.sdk.paywallui

/** Bound on the in-memory bitmap cache. Paywalls are small trees with a
 *  handful of distinct images; this is sized to hold a whole paywall's
 *  worth several times over without becoming a memory footprint of its
 *  own. Mirrors IMAGE_CACHE_MAX_ENTRIES in schema.ts. */
internal const val IMAGE_CACHE_MAX_ENTRIES = 32

/**
 * A least-recently-used cache keyed by image URL.
 *
 * Generic over its value type ONLY so the JVM unit tests can exercise it:
 * this module's `android.jar` is the gutted compile-time stub, so a test
 * cannot construct a real `Bitmap`. Production use is `BitmapLruCache<Bitmap>`.
 *
 * `LinkedHashMap` in access order IS the LRU — `removeEldestEntry` is the
 * eviction hook, so this is deliberately not a hand-written list.
 */
internal class BitmapLruCache<V>(private val maxEntries: Int = IMAGE_CACHE_MAX_ENTRIES) {
    private val map = object : LinkedHashMap<String, V>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, V>?): Boolean =
            size > maxEntries
    }

    @Synchronized fun get(url: String): V? = map[url]
    @Synchronized fun put(url: String, value: V) { map[url] = value }
    val size: Int @Synchronized get() = map.size
}

/**
 * The `BitmapFactory.Options.inSampleSize` for decoding a [sourceWidth] x
 * [sourceHeight] image into a [targetWidth] x [targetHeight] slot: the
 * largest power of two that still covers the target. Decoding a 2000 px
 * hero at full size into a 300 px slot is the waste this removes.
 *
 * A zero or unknown target (a view not yet measured) yields 1 — full
 * quality — because guessing small would ship a blurry image permanently.
 */
internal fun sampleSizeFor(sourceWidth: Int, sourceHeight: Int, targetWidth: Int, targetHeight: Int): Int {
    if (targetWidth <= 0 || targetHeight <= 0) return 1
    var sample = 1
    while (sourceWidth / (sample * 2) >= targetWidth && sourceHeight / (sample * 2) >= targetHeight) {
        sample *= 2
    }
    return sample
}
```

- [ ] **Step 4: Run the cache tests**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests '*ImageCacheTest*'`
Expected: PASS.

- [ ] **Step 5: Wire it into `loadImageInto`**

In `NodeViewFactory.kt`, hold one module-level `BitmapLruCache<Bitmap>`. `loadImageInto` must:
1. return the cached bitmap synchronously when present — no coroutine launched at all, so a rebuild is a map lookup;
2. otherwise decode with `inJustDecodeBounds = true` first, compute `sampleSizeFor` against the target `ImageView`'s measured size, decode for real, then `put` before setting;
3. keep the existing `isActive` guard and the existing timeouts.

- [ ] **Step 6: Run the whole Kotlin suite**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: all green (was 288 passing, 0 failures).

- [ ] **Step 7: Mutation-check**

Change `removeEldestEntry` to return `false` (never evict) and confirm the eviction test fails. Restore. Change `LinkedHashMap`'s access-order flag to `false` and confirm the LRU-ordering test fails. Restore.

Then state plainly in your report what the JVM tests do NOT prove: that `loadImageInto` actually avoids the fetch on a rebuild is not observable here (no real `Bitmap`, no network) and belongs on the device smoke checklist.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/ImageCache.kt \
        packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/NodeViewFactory.kt \
        packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/ImageCacheTest.kt
git commit -m "perf(sdk-kotlin): cache and downsample paywall images"
```

---

### Task 3: Builder authoring surface

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/node-meta.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/tree-ops.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/tabs.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/content-tab.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/style-tab.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/overrides.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Test: `__tests__/node-meta.test.ts`, `__tests__/tree-ops.test.ts`, `inspector/tabs.test.ts`, `inspector/overrides.test.tsx`

**Interfaces:**
- Consumes: `CarouselNode`, `CAROUSEL_DEFAULT_SHOWS_INDICATOR`, `CAROUSEL_DEFAULT_LOOP` from Task 1.

**This task's file list is the whole point.** Wave B shipped two node types with **no inspector at all** because `inspector/tabs.ts` was left off a task's file list and `tabsForNode` returned an empty array. Do not drop a file here.

`carousel` is a CONTAINER: `tree-ops.ts` must accept children for it exactly as it does for `stack` and `stickyFooter`, or an author can create a carousel and never put anything in it.

- [ ] **Step 1: Write the failing tests**

```ts
// tabs.test.ts — the wave-B scar
it("gives carousel a non-empty tab set", () => {
  expect(tabsForNode("carousel")).not.toHaveLength(0);
});

// node-meta.test.ts
it("exposes carousel in the palette with a label and icon", () => {
  expect(NODE_META.carousel.labelKey).toBeTruthy();
});

// tree-ops.test.ts
it("accepts children into a carousel", () => {
  const tree = newNode("carousel", idGen);
  const withChild = insertChild(tree, newNode("text", idGen));
  expect(withChild.children).toHaveLength(1);
});

// overrides.test.tsx
it("renders an indicatorColor control for a carousel override", () => {
  render(<OverrideEditor node={carouselNode} combo={someCombo} />);
  expect(screen.getByLabelText(/indicator/i)).toBeInTheDocument();
});
```

Match each file's existing test helpers and import style rather than inventing new ones.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/dashboard && npx vitest run src/components/paywall-builder`
Expected: FAIL on all four.

- [ ] **Step 3: Implement**

1. `node-meta.ts` — palette entry with label key and icon, following the `stickyFooter` entry's shape.
2. `tree-ops.ts` — add `carousel` wherever `stack`/`stickyFooter` are treated as containers (child insertion, drag targets, `newNode` giving it an empty `children` array).
3. `inspector/tabs.ts` — give `carousel` content + style + visibility tabs.
4. `content-tab.tsx` — `autoAdvanceSeconds` (number, empty = off), `loop` (toggle, default from `CAROUSEL_DEFAULT_LOOP`), `showsIndicator` (toggle, default from `CAROUSEL_DEFAULT_SHOWS_INDICATOR`). Use the shared constants for the defaults shown; do not hard-code `true`/`false` in the JSX.
5. `style-tab.tsx` — `indicatorColor` theme-colour field, left empty meaning inherit.
6. `overrides.tsx` — the `indicatorColor` control, so the override keys the schema declares actually have UI. (Wave B shipped an override that rendered an empty control because no UI task was told.)
7. `en.json` — the new label/help strings. **Add keys only; do not reorder or reformat the file** — a parallel agent is also adding keys to it.

- [ ] **Step 4: Run the builder tests**

Run: `cd apps/dashboard && npx vitest run src/components/paywall-builder`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Remove the `carousel` row from `tabsForNode` and confirm the tab test fails. Restore. Remove `carousel` from the container list in `tree-ops.ts` and confirm the child-insertion test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): author carousel nodes"
```

---

### Task 4: Web renderer

**Files:**
- Modify: `packages/paywall-renderer/src/nodes.tsx`
- Modify: `packages/paywall-renderer/src/styles.ts`
- Test: `packages/paywall-renderer/src/renderer.test.tsx`

**Interfaces:**
- Consumes: `CarouselNode` and the three constants from Task 1.

Paging is **CSS scroll-snap**, not JS scroll maths: the track is a flex row with `scroll-snap-type: x mandatory` and `overflow-x: auto`; each page is `flex: 0 0 100%` with `scroll-snap-align: center`. The current page is tracked from the scroll position for the dots; auto-advance sets `scrollLeft`.

Auto-advance obeys spec §5. Web already has the pattern from wave C's countdown: `visibilitychange` plus an `IntersectionObserver`, both halves — stop AND resume.

- [ ] **Step 1: Write the failing tests**

```tsx
it("renders each child once", () => {
  const { container } = renderPaywall(carouselWith(pageA, pageB, pageC));
  expect(container.querySelectorAll("[data-rov-carousel-page]")).toHaveLength(3);
});

it("draws one dot per page when showsIndicator is absent", () => {
  const { container } = renderPaywall(carouselWith(pageA, pageB));
  expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(2);
});

it("draws no dots when showsIndicator is false", () => {
  const { container } = renderPaywall(carouselWith(pageA, pageB, { showsIndicator: false }));
  expect(container.querySelectorAll("[data-rov-carousel-dot]")).toHaveLength(0);
});

it("declares mandatory x snapping on the track", () => {
  const { container } = renderPaywall(carouselWith(pageA, pageB));
  const track = container.querySelector("[data-rov-carousel-track]") as HTMLElement;
  expect(track.style.scrollSnapType).toBe("x mandatory");
});

it("renders fallback for an empty carousel", () => {
  const { container } = renderPaywall(carouselWith({ children: [], fallback: textNode("nope") }));
  expect(container.textContent).toContain("nope");
});

it("stops the auto-advance interval when the document hides", () => {
  vi.useFakeTimers();
  const { container } = renderPaywall(carouselWith(pageA, pageB, { autoAdvanceSeconds: 3 }));
  fireEvent(document, new Event("visibilitychange"));  // with visibilityState stubbed to "hidden"
  const before = trackScrollLeft(container);
  vi.advanceTimersByTime(10_000);
  expect(trackScrollLeft(container)).toBe(before);
});
```

Add `data-rov-carousel-track`, `data-rov-carousel-page` and `data-rov-carousel-dot` attributes — the renderer already uses `data-rov-*` hooks for exactly this, and asserting on a bare `<div>` would pass with the feature broken.

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/paywall-renderer && npx vitest run`

- [ ] **Step 3: Implement `renderCarousel`**

Add the `case "carousel":` arm to the dispatcher in `nodes.tsx` — the dispatcher has **no `default` branch**; it ends in `const exhaustive: never = resolved`, so adding the union member without the arm is a compile error. Put the style literals (dot size, gap, active/inactive opacity) in named constants in `styles.ts`.

An absent `indicatorColor` **inherits** — emit no colour, matching how the renderer's other "inherit" props behave. Verify at the resolved value, not the branch.

- [ ] **Step 4: Run the web suite**

Run: `cd packages/paywall-renderer && npx vitest run`
Expected: all green (was 108 passing).

- [ ] **Step 5: Mutation-check**

Hard-code `scrollSnapType` to `"none"` and confirm the snapping test fails. Restore. Make the dots render unconditionally and confirm the `showsIndicator: false` test fails. Restore.

State plainly what jsdom cannot prove: it computes no layout, so real snapping, real page width and the dot tracking the real scroll position are browser-smoke items, not tested claims.

- [ ] **Step 6: Commit**

```bash
git add packages/paywall-renderer/src
git commit -m "feat(paywall-renderer): page through a carousel"
```

---

### Task 5: SwiftUI renderer

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/BuilderConfigModel.swift`
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/RovenuePaywallView.swift`
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/PaywallOverrides.swift`
- Test: `packages/sdk-swift/Tests/RovenueTests/BuilderConfigModelTests.swift`, `PaywallRenderSupportTests.swift`

**Interfaces:**
- Consumes: the `render-fixtures.json` cases and `defaults` keys from Task 1.

Paging is `TabView` with `.tabViewStyle(.page)` — available since iOS 14, well under this package's **iOS 16** floor. It supplies paging AND dots, so `showsIndicator` maps to `.indexViewStyle`/`.tabViewStyle(.page(indexDisplayMode:))` rather than hand-drawn dots. `ScrollView.scrollTargetBehavior(.paging)` is iOS 17+ and must NOT be used.

Auto-advance obeys spec §5, following the countdown's existing pattern in this file.

- [ ] **Step 1: Write the failing decode tests**

```swift
func test_decodesBareCarouselFromTheSharedFixture() throws {
    let node = try decodeNode(named: "carousel-bare")   // select by NAME, never by index
    guard case .carousel(let p) = node else { return XCTFail("expected carousel") }
    XCTAssertEqual(p.children.count, 2)
    XCTAssertNil(p.showsIndicator)
    XCTAssertNil(p.autoAdvanceSeconds)
}

func test_nativeCarouselDefaultsMatchTheSharedFixtureByValue() throws {
    let defaults = try fixtureDefaults()
    XCTAssertEqual(carouselDefaultShowsIndicator, defaults["CAROUSEL_DEFAULT_SHOWS_INDICATOR"] as? Bool)
    XCTAssertEqual(carouselDefaultLoop, defaults["CAROUSEL_DEFAULT_LOOP"] as? Bool)
    XCTAssertEqual(Double(carouselMinAutoAdvanceSeconds), defaults["CAROUSEL_MIN_AUTO_ADVANCE_SECONDS"] as? Double)
}
```

Add the three assertions into the EXISTING by-value defaults sync test rather than a new one, matching its neighbours. If a constant is declared `private`, widen it to `let` — Swift's `private` is file-scoped and even `@testable import` cannot cross it (this exact thing was hit once already).

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/sdk-swift && swift test`

- [ ] **Step 3: Implement**

`BuilderConfigModel.swift`: the `carousel` case, `CarouselProps`, the lenient decode, and the three mirrored constants with a comment saying they mirror `schema.ts` by hand.
`PaywallOverrides.swift`: the `indicatorColor` override key.
`RovenuePaywallView.swift`: the `carouselView(_:)` builder.

- [ ] **Step 4: Run the Swift suite**

Run: `cd packages/sdk-swift && swift test`
Expected: all green (was 230 passing, 0 failures).

**Note:** SourceKit/IDE diagnostics in this repo have been stale and wrong **seven times** this session, every one contradicted by a green `swift test`. Trust the build, not the editor.

- [ ] **Step 5: Mutation-check**

Change `carouselDefaultLoop` to `true` and confirm the by-value sync test fails. Restore.

Then state plainly what SwiftUI structural tests cannot prove: they read the composed generic type of `body`, which exposes structure but not numbers, so paging feel, real page width and dot tracking are device-smoke items.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-swift/Sources packages/sdk-swift/Tests
git commit -m "feat(sdk-swift): page through a carousel"
```

---

### Task 6: Android renderer

**Files:**
- Modify: `packages/sdk-kotlin/build.gradle.kts` (add `androidx.viewpager2`)
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModel.kt`
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/NodeViewFactory.kt`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModelTest.kt`, `NodeViewFactoryTest.kt`

**Interfaces:**
- Consumes: Task 1's fixture cases and `defaults`; Task 2's `BitmapLruCache` (already wired — do not re-wire it).

Paging is **`androidx.viewpager2`**, the one new dependency this wave adds:

```kotlin
implementation("androidx.viewpager2:viewpager2:1.1.0")
```

Our `minSdk` is 24 against its floor of 14. The alternative — a `HorizontalScrollView` with hand-written snapping, page tracking, dot synchronisation and auto-advance — is four mechanisms this repo would then own and debug on devices.

Dots are drawn (ViewPager2 has no built-in indicator). An absent `indicatorColor` **inherits the ambient text ink**. Heed the wave-B scar on this exact platform: the Kotlin honoured "never substitute" perfectly in its branch and Android still drew the wrong colour, because the substituted value had moved into a vendored drawable asset. Verify at the resolved colour.

Auto-advance obeys spec §5. Follow `CountdownRow`'s existing pattern in `NodeViewFactory.kt`: a View subclass that posts and removes its own `Handler` in its OWN `onAttachedToWindow`/`onDetachedFromWindow`, so resume is automatic and nothing outlives the view.

Keep this module's split: render LOGIC in pure JVM-testable helpers, view construction smoke-tested. **Do not add Robolectric** — it was removed because the JUnit5-platform test tasks could never discover its JUnit4-style tests.

- [ ] **Step 1: Write the failing tests**

```kotlin
@Test
fun `decodes the bare carousel from the shared fixture`() {
    val node = decodeFixtureNode("carousel-bare")   // by NAME, never by index
    assertTrue(node is BuilderNode.Carousel)
    assertEquals(2, (node as BuilderNode.Carousel).children.size)
    assertNull(node.showsIndicator)
}

@Test
fun `native carousel defaults match the shared fixture by value`() {
    val defaults = fixtureDefaults()
    assertEquals(defaults["CAROUSEL_DEFAULT_SHOWS_INDICATOR"], CAROUSEL_DEFAULT_SHOWS_INDICATOR)
    assertEquals(defaults["CAROUSEL_DEFAULT_LOOP"], CAROUSEL_DEFAULT_LOOP)
    assertEquals(defaults["CAROUSEL_MIN_AUTO_ADVANCE_SECONDS"], CAROUSEL_MIN_AUTO_ADVANCE_SECONDS)
}

@Test
fun `the next page index wraps only when loop is true`() {
    assertEquals(0, nextCarouselPage(current = 2, pageCount = 3, loop = true))
    assertEquals(2, nextCarouselPage(current = 2, pageCount = 3, loop = false))
}
```

`nextCarouselPage` is a pure helper — it is where the loop rule lives, and making it pure is what lets it be tested at all. With `loop = false` it returns the current index unchanged at the end, which is the signal to stop the timer permanently (spec §5).

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`

- [ ] **Step 3: Implement**

Add the dependency, `BuilderNode.Carousel` + lenient decode + the three mirrored constants, the pure `nextCarouselPage` helper, and the `ViewPager2`-backed builder with drawn dots.

- [ ] **Step 4: Run the Kotlin suite**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: all green. Not a compile task — `compileReleaseKotlin` only builds main and misses red tests.

- [ ] **Step 5: Mutation-check**

Make `nextCarouselPage` always wrap and confirm the `loop = false` case fails. Restore. Change `CAROUSEL_DEFAULT_LOOP` and confirm the by-value sync test fails. Restore.

Then state plainly what the JVM tests cannot prove: no real measure/layout pass is observable here (gutted `android.jar`, no Robolectric), so paging feel, dot tracking, and the Task 2 cache actually avoiding a re-fetch are all device-smoke items.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-kotlin/build.gradle.kts packages/sdk-kotlin/src
git commit -m "feat(sdk-kotlin): page through a carousel"
```

---

### Task 7: Device and browser smoke session

**Human-only.** Not dispatchable to a subagent, and the wave does not close without it. Every renderer task above ends by naming what its tests could not prove; those items land here.

Review Tasks 4–6 **together, in one review**, before this session — both Criticals in wave A, both in wave B, and nine of eighteen findings in wave C came only from that comparison.

- [ ] **Web** — a three-page carousel in the builder canvas and the runner: pages snap, dots track the real page, `showsIndicator: false` hides them, an `autoAdvanceSeconds: 3` carousel stops when the tab is hidden and resumes on return, and a hand swipe restarts the interval rather than racing it.
- [ ] **iOS** — the same config: paging feel, dots, auto-advance stopping when the paywall goes off-screen and resuming, `loop: false` stopping permanently on the last page.
- [ ] **Android** — the same, plus the two Android-only items: with `loop: false` the timer must stop rather than fire against a clamped index; and **the substrate check** — a five-image carousel on screen, tap between packages 20–30 times while watching the network, which must show image fetches only on the first pass.
- [ ] **All three, one config** — screenshot the same carousel JSON on all three at the same viewport and diff page width, dot position and active-dot styling.

---

## Self-Review

**Spec coverage:** §2 substrate → Task 2. §3 type and paging → Tasks 1, 4, 5, 6. §3.2 indicator → Tasks 4, 5, 6. §3.3 auto-advance and the loop rule → Tasks 4, 5, 6 (the loop rule is pinned by a pure helper in Task 6 and by tests in 4 and 5). §4 constants and fixtures → Task 1, with by-value native comparisons in Tasks 5 and 6. §5 lifecycle → Tasks 4, 5, 6 and the Task 7 checklist. §6 validator → Task 1. §7 testing → every task's mutation-check step plus Task 7. §8 rule 1 (pair the obligations, including `inspector/tabs.ts`) → Task 3's file list.

**Type consistency:** `CarouselNode`, `CAROUSEL_DEFAULT_SHOWS_INDICATOR`, `CAROUSEL_DEFAULT_LOOP`, `CAROUSEL_MIN_AUTO_ADVANCE_SECONDS`, `IMAGE_CACHE_MAX_ENTRIES`, `BitmapLruCache<V>`, `sampleSizeFor`, `nextCarouselPage` — each defined once and used with the same name and signature throughout.

**Gap found and closed during review:** Task 3 originally omitted `tree-ops.ts`, which would have let an author create a carousel that could never hold a page — the same class of omission that shipped two inspector-less node types in wave B. It is now in the file list with its own test.
