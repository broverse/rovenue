# Paywall node types wave D2 (`video`, `lottie`, one lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `video` and `lottie` node types across the shared schema, the builder and all three renderers, on top of one visibility detector per platform that also takes over `countdown` and `carousel`.

**Architecture:** Each platform gains a single "is this node on screen and is the app in front" facility. Four consumers use it: the two new media nodes and the two existing time-driven ones. `video` uses each platform's built-in player and adds no dependency. `lottie` is understood by the schema but rendered only by a handler the host registers explicitly; with none registered the node falls through the existing `fallback` machinery.

**Tech Stack:** TypeScript (strict) + Zod + Vitest; React 19; SwiftUI (iOS 16 floor); Android Views + Kotlin (minSdk 24, JUnit5).

**Spec:** `docs/superpowers/specs/2026-07-28-paywall-node-types-wave-d2-design.md`. Read §2 (the detector), §5 (defaults) and §8 (the ten binding rules) before starting any task.

## Global Constraints

- **No magic values.** Every literal is a named constant. Cross-platform values live in `packages/shared/src/paywall/schema.ts` and are mirrored by hand into Swift and Kotlin; mirror the VALUE, never re-decide it.
- Absent-prop behaviour is a named shared constant or explicitly "inherit". `aspectRatio` absent = **the source's own ratio**, never a substituted number. `posterUrl` absent = no poster.
- `VIDEO_DEFAULT_AUTOPLAY = true`; `VIDEO_DEFAULT_LOOP = true`; `VIDEO_DEFAULT_MUTED = true`; `VIDEO_DEFAULT_SHOWS_CONTROLS = false`; `LOTTIE_DEFAULT_LOOP = true`; `LOTTIE_DEFAULT_AUTOPLAY = true`; `LOTTIE_DEFAULT_SPEED = 1`; `LOTTIE_MIN_SPEED = 0.1`; `LOTTIE_MAX_SPEED = 4`.
- **The detector is built once per platform.** If it ends up written separately inside three node types on one platform, the task has failed its point.
- **No new dependency.** `video` uses `<video>`, `AVPlayer`, and `MediaPlayer` on a `TextureView`. No ExoPlayer, no AVKit beyond `AVPlayer`, no bundled Lottie.
- Lottie registration is an **explicit function call** on every platform — no reflection, no class probing.
- A node that renders nothing is dropped (wave D1's rule, still binding), and inside a `carousel` that means no phantom dot.
- No `default` branch in a **builder** per-type dispatcher; use `const exhaustive: never = node`. A **renderer** dispatcher's `default → fallback` arm is correct and stays.
- `render-fixtures.json` is the three-platform decoder contract. Every new `defaults` key needs a by-value comparison in the Swift AND Kotlin sync tests, or it is pinned for web only.
- Never create or switch branches or worktrees; commit on the current branch. `git add` only the files the task touches — never `git add -A`. A parallel agent is active elsewhere in this repo; on an `index.lock` error, wait ~5 seconds and retry.
- **A test that passes with the feature broken is worse than no test.** Mutation-check every claim. Where no test can catch a defect, say so plainly and move it to the smoke checklist. **Never describe a test you did not write.**

---

## File Structure

**Shared contract** (Task 1)
- `packages/shared/src/paywall/schema.ts` — `ThemeUrl`, `VideoNode`, `LottieNode`, nine constants, `OVERRIDABLE_PROP_KEYS` rows, Zod members
- `packages/shared/src/paywall/validate.ts` — `LOCALIZED_KEYS` rows, three issue codes
- `packages/shared/src/paywall/render-fixtures.json` — accept cases + nine `defaults` keys

**Builder** (Task 2)
- `node-meta.ts`, `inspector/tabs.ts`, `inspector/content-tab.tsx`, `inspector/style-tab.tsx`, `inspector/overrides.tsx`, `i18n/locales/en.json`

**Web** (Tasks 3–4)
- `packages/paywall-renderer/src/visibility.ts` (new) — the shared hook
- `packages/paywall-renderer/src/nodes.tsx`, `styles.ts`, `index.ts`

**iOS** (Tasks 5–6)
- `packages/sdk-swift/Sources/Rovenue/PaywallUI/NodeVisibility.swift` (new)
- `.../BuilderConfigModel.swift`, `RovenuePaywallView.swift`, `PaywallOverrides.swift`
- `.../RovenuePaywallLottie.swift` (new) — the registration point

**Android** (Tasks 7–8)
- `.../paywallui/NodeVisibility.kt` (new)
- `.../paywallui/{BuilderConfigModel,NodeViewFactory,PaywallOverrides}.kt`

---

### Task 1: Shared contract — `ThemeUrl`, `video`, `lottie`

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts`
- Modify: `packages/shared/src/paywall/validate.ts`
- Modify: `packages/shared/src/paywall/render-fixtures.json`
- Test: `packages/shared/src/paywall/schema.test.ts`, `validate.test.ts`, `render-fixtures.test.ts`

**Interfaces:**
- Produces: `ThemeUrl`; `VideoNode`; `LottieNode`; the nine constants above; issue codes `VIDEO_AUTOPLAY_UNMUTED`, `VIDEO_NO_POSTER`, `LOTTIE_SPEED_OUT_OF_RANGE`.

- [ ] **Step 1: Write the failing schema tests**

```ts
it("round-trips a video with every optional prop absent", () => {
  const node = { type: "video", id: "v1", url: { light: "https://x/a.mp4" } };
  expect(paywallNodeSchema.parse(node)).toEqual(node);
});

it("round-trips a lottie with every optional prop absent", () => {
  const node = { type: "lottie", id: "l1", url: { light: "https://x/a.json" } };
  expect(paywallNodeSchema.parse(node)).toEqual(node);
});

it("rejects a video with no url", () => {
  expect(() => paywallNodeSchema.parse({ type: "video", id: "v1" })).toThrow();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/shared && npx vitest run src/paywall/schema.test.ts`
Expected: FAIL — the union has no `video` or `lottie` member.

- [ ] **Step 3: Add `ThemeUrl` and move `image` onto it**

`ThemeColor` at `schema.ts:17` already has exactly this shape and style; follow it.

```ts
export type ThemeUrl = { light: string; dark?: string };
```

Then change `ImageNode.url` (currently the inline `{ light: string; dark?: string }` at `schema.ts:67`) to `ThemeUrl`. This is a pure rename of an identical shape — no behaviour change, no migration, and `tsc` will confirm it.

- [ ] **Step 4: Add the two node types, the constants and the Zod members**

```ts
export type VideoNode = {
  type: "video";
  id: string;
  url: ThemeUrl;
  posterUrl?: ThemeUrl;
  /** Absent = VIDEO_DEFAULT_AUTOPLAY. */
  autoplay?: boolean;
  /** Absent = VIDEO_DEFAULT_LOOP. */
  loop?: boolean;
  /** Absent = VIDEO_DEFAULT_MUTED. Autoplay with sound is refused by
   *  browsers — see the validator's VIDEO_AUTOPLAY_UNMUTED. */
  muted?: boolean;
  /** Absent = VIDEO_DEFAULT_SHOWS_CONTROLS. */
  showsControls?: boolean;
  /** Width ÷ height. Absent = the source's own ratio once known — NOT a
   *  substituted number. */
  aspectRatio?: number;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

export type LottieNode = {
  type: "lottie";
  id: string;
  url: ThemeUrl;
  /** Absent = LOTTIE_DEFAULT_LOOP. */
  loop?: boolean;
  /** Absent = LOTTIE_DEFAULT_AUTOPLAY. */
  autoplay?: boolean;
  /** Absent = LOTTIE_DEFAULT_SPEED. */
  speed?: number;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

Add both to the `PaywallNode` union. The constants, beside the other waves':

```ts
export const VIDEO_DEFAULT_AUTOPLAY = true;
export const VIDEO_DEFAULT_LOOP = true;
/** Browsers refuse to autoplay a video with sound, so muted is the only
 *  default under which autoplay works on all three platforms. */
export const VIDEO_DEFAULT_MUTED = true;
export const VIDEO_DEFAULT_SHOWS_CONTROLS = false;
export const LOTTIE_DEFAULT_LOOP = true;
export const LOTTIE_DEFAULT_AUTOPLAY = true;
export const LOTTIE_DEFAULT_SPEED = 1;
/** Outside this range playback reads as broken rather than stylised.
 *  Authoring-time advice (a `warning`), not a clamp. */
export const LOTTIE_MIN_SPEED = 0.1;
export const LOTTIE_MAX_SPEED = 4;
```

`OVERRIDABLE_PROP_KEYS` gains `video: ["url", "posterUrl"]` and `lottie: ["url"]`.

Zod members, in the neighbouring style (each annotated `z.ZodType<T>` because `z.lazy` degrades inference):

```ts
const themeUrlSchema: z.ZodType<ThemeUrl> = z.object({
  light: z.string(),
  dark: z.string().optional(),
});
```

`videoNodeSchema` and `lottieNodeSchema` mirror the two types above; `speed` is `z.number().positive().optional()`.

- [ ] **Step 5: Run the schema tests**

Run: `cd packages/shared && npx vitest run src/paywall/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing validator tests**

```ts
it("raises VIDEO_AUTOPLAY_UNMUTED when autoplay is on and muted is off", () => {
  const node = { type: "video", id: "v1", url: { light: "u" }, autoplay: true, muted: false };
  const issues = validateBuilderConfig(configWith(node), "warning");
  expect(issues.map((i) => i.code)).toContain("VIDEO_AUTOPLAY_UNMUTED");
});

it("does NOT raise VIDEO_AUTOPLAY_UNMUTED for the defaults", () => {
  const node = { type: "video", id: "v1", url: { light: "u" } };
  const issues = validateBuilderConfig(configWith(node), "warning");
  expect(issues.map((i) => i.code)).not.toContain("VIDEO_AUTOPLAY_UNMUTED");
});

it("raises VIDEO_NO_POSTER when autoplay is off and no poster is given", () => {
  const node = { type: "video", id: "v1", url: { light: "u" }, autoplay: false };
  const issues = validateBuilderConfig(configWith(node), "warning");
  expect(issues.map((i) => i.code)).toContain("VIDEO_NO_POSTER");
});

it("raises LOTTIE_SPEED_OUT_OF_RANGE above the ceiling", () => {
  const node = { type: "lottie", id: "l1", url: { light: "u" }, speed: 99 };
  const issues = validateBuilderConfig(configWith(node), "warning");
  expect(issues.map((i) => i.code)).toContain("LOTTIE_SPEED_OUT_OF_RANGE");
});

it("does NOT raise LOTTIE_SPEED_OUT_OF_RANGE at either bound", () => {
  for (const speed of [LOTTIE_MIN_SPEED, LOTTIE_MAX_SPEED]) {
    const node = { type: "lottie", id: "l1", url: { light: "u" }, speed };
    const issues = validateBuilderConfig(configWith(node), "warning");
    expect(issues.map((i) => i.code)).not.toContain("LOTTIE_SPEED_OUT_OF_RANGE");
  }
});
```

Use the file's existing `configWith` helper rather than hand-building a `BuilderConfig`.

**Note on the last test:** it references the constants it guards, so it pins the *comparison* (inclusive vs exclusive bounds), not the constants' *values*. The values are pinned by the fixture's by-value assertions in Step 8. That distinction bit this project once — do not assume mutating a constant will fail this test.

- [ ] **Step 7: Implement the validator changes**

Add `video: () => []` and `lottie: () => []` to `LOCALIZED_KEYS` — neither carries localized text of its own, and the mapped type is exhaustive so omitting a row is a compile error. Raise the three issues, all at `warning` tier.

- [ ] **Step 8: Widen the fixture contract**

Add to `accept`, **named** (tests select by name, never index — a previous wave broke two Kotlin tests that assumed a position): `"video-bare"`, `"video-full"` (poster, `autoplay: false`, `loop: false`, `muted: false`, `showsControls: true`, `aspectRatio: 1.777`), `"lottie-bare"`, `"lottie-full"`.

Add the nine new keys to `defaults`, and assert each equals the exported constant by value in `render-fixtures.test.ts`.

- [ ] **Step 9: Run the whole shared suite**

Run: `cd packages/shared && npx vitest run`
Expected: all green (was 638 passing).

- [ ] **Step 10: Mutation-check**

Change `VIDEO_DEFAULT_MUTED` to `false` and confirm the "does NOT raise for the defaults" test fails. Restore. Delete the `lottie` row from `LOCALIZED_KEYS` and confirm the build fails to compile (that is the exhaustiveness property, and it is the check that matters here).

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/paywall/schema.ts packages/shared/src/paywall/validate.ts \
        packages/shared/src/paywall/render-fixtures.json packages/shared/src/paywall/schema.test.ts \
        packages/shared/src/paywall/validate.test.ts packages/shared/src/paywall/render-fixtures.test.ts
git commit -m "feat(shared): add the video and lottie node types"
```

---

### Task 2: Builder authoring surface

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/node-meta.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/tabs.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/content-tab.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/style-tab.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/overrides.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Test: `__tests__/node-meta.test.ts`, `inspector/tabs.test.ts`, `inspector/overrides.test.tsx`

**Interfaces:**
- Consumes: `VideoNode`, `LottieNode` and the nine constants from Task 1.

`video` and `lottie` are **leaves**, not containers, so `tree-ops.ts` needs nothing beyond `newNode` cases. But `inspector/tabs.ts` IS in this list and must stay: wave B shipped two node types with no inspector at all because that file was left off a task's list and `tabsForNode` returned an empty array.

- [ ] **Step 1: Write the failing tests**

```ts
// tabs.test.ts — the wave-B scar
it("gives video a non-empty tab set", () => {
  expect(tabsForNode("video")).not.toHaveLength(0);
});
it("gives lottie a non-empty tab set", () => {
  expect(tabsForNode("lottie")).not.toHaveLength(0);
});

// node-meta.test.ts
it("exposes video and lottie in the palette", () => {
  expect(NODE_TYPES).toContain("video");
  expect(NODE_TYPES).toContain("lottie");
});
```

Match each file's existing helpers and import style; the real names here are `NODE_TYPES` / `NODE_ICON` / `NODE_TYPE_LABEL`, not `NODE_META`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/dashboard && npx vitest run src/components/paywall-builder`

- [ ] **Step 3: Implement**

1. `node-meta.ts` — palette entries with label keys and icons, following the `image` entry's shape.
2. `tree-ops.ts` — `newNode` cases returning `{ type: "video", id, url: { light: "" } }` and `{ type: "lottie", id, url: { light: "" } }`.
3. `inspector/tabs.ts` — content + style + visibility tabs for both.
4. `content-tab.tsx` — video: url, posterUrl, `autoplay`/`loop`/`muted`/`showsControls` toggles defaulting from the shared constants, `aspectRatio` (empty = source's own). lottie: url, `loop`/`autoplay` toggles, `speed` number.
5. `style-tab.tsx` — nothing style-specific for either; confirm the tab set you declared in step 3 matches what you actually render, so no empty tab ships.
6. `overrides.tsx` — controls for the override keys Task 1 declared (`url`, `posterUrl` for video; `url` for lottie). Wave B shipped an override that rendered an empty control because no UI task was told.
7. `en.json` — **add keys only; do not reorder or reformat.** A parallel agent is also adding keys to this file.

- [ ] **Step 4: Run the builder tests**

Run: `cd apps/dashboard && npx vitest run src/components/paywall-builder`
Expected: PASS. The full dashboard suite has ~10 pre-existing unrelated failures; confirm you did not add to them.

- [ ] **Step 5: Mutation-check**

Remove the `video` row from `tabsForNode` and confirm the tab test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): author video and lottie nodes"
```

---

### Task 3: Web visibility hook, and move `countdown` + `carousel` onto it

**Files:**
- Create: `packages/paywall-renderer/src/visibility.ts`
- Modify: `packages/paywall-renderer/src/nodes.tsx` (the countdown's inline observers at ~`:836-853`, and the carousel's)
- Modify: `packages/paywall-renderer/src/index.ts`
- Test: `packages/paywall-renderer/src/renderer.test.tsx`

**Interfaces:**
- Produces: `useNodeVisible(element: HTMLElement | null): boolean` — true when the document is visible AND the element intersects the viewport.

The web already has both halves, written inline inside the countdown component. This task extracts them and gives the carousel the same treatment, so all three later consumers share one implementation.

**Fail open.** The existing code documents this and it must survive extraction: absent `IntersectionObserver` (jsdom, very old engines) the node counts as on-screen. A stopped clock is worse than a running one.

- [ ] **Step 1: Write the failing test**

```tsx
it("reports not-visible once the document hides", () => {
  const { result } = renderHook(() => useNodeVisible(document.createElement("div")));
  expect(result.current).toBe(true);            // fail open, no observer in jsdom
  act(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(result.current).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/paywall-renderer && npx vitest run`
Expected: FAIL — `useNodeVisible` is not defined.

- [ ] **Step 3: Extract the hook**

Move the two `useEffect`s out of the countdown component into `visibility.ts` as `useNodeVisible`, preserving the fail-open comment and behaviour verbatim. Export it from `index.ts`.

- [ ] **Step 4: Move both existing consumers onto it**

The countdown drops its inline observers and calls the hook. The carousel — which today pauses on `visibilitychange` only — does the same, so it gains the scrolled-out-of-view half for free. Its `loop: false` stop-latch must survive a pause/resume cycle: pausing is not reaching the end.

- [ ] **Step 5: Run the web suite**

Run: `cd packages/paywall-renderer && npx vitest run`
Expected: all green (was 126 passing). The existing countdown and carousel visibility tests must still pass **unchanged** — if you had to edit one, say why in your report, because that is how a test that encodes a defect gets introduced.

- [ ] **Step 6: Mutation-check**

Make `useNodeVisible` always return `true` and confirm the countdown's and the carousel's pause tests fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/paywall-renderer/src
git commit -m "refactor(paywall-renderer): one visibility hook for every time-driven node"
```

---

### Task 4: Web `video` and `lottie`

**Files:**
- Modify: `packages/paywall-renderer/src/nodes.tsx`, `styles.ts`, `index.ts`
- Test: `packages/paywall-renderer/src/renderer.test.tsx`

**Interfaces:**
- Consumes: `useNodeVisible` from Task 3; `VideoNode`, `LottieNode` and the constants from Task 1.
- Produces: `registerLottieRenderer(render: LottieRenderer | null): void` and `type LottieRenderer = (props: { url: string; loop: boolean; autoplay: boolean; speed: number; playing: boolean }) => ReactElement | null`, both exported from `index.ts`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("renders a muted, looping, autoplaying video by default", () => {
  const { container } = renderPaywall(videoNode({ url: { light: "u.mp4" } }));
  const el = container.querySelector("video") as HTMLVideoElement;
  expect(el.muted).toBe(true);
  expect(el.loop).toBe(true);
  expect(el.autoplay).toBe(true);
  expect(el.controls).toBe(false);
});

it("uses posterUrl as the poster", () => {
  const { container } = renderPaywall(videoNode({ url: { light: "u.mp4" }, posterUrl: { light: "p.jpg" } }));
  expect((container.querySelector("video") as HTMLVideoElement).poster).toContain("p.jpg");
});

it("renders a lottie node's fallback when no renderer is registered", () => {
  registerLottieRenderer(null);
  const { container } = renderPaywall(lottieNode({ url: { light: "a.json" }, fallback: textNode("no lottie") }));
  expect(container.textContent).toContain("no lottie");
});

it("hands a registered lottie renderer the resolved defaults", () => {
  const seen: unknown[] = [];
  registerLottieRenderer((props) => { seen.push(props); return null; });
  renderPaywall(lottieNode({ url: { light: "a.json" } }));
  expect(seen[0]).toMatchObject({ url: "a.json", loop: true, autoplay: true, speed: 1 });
  registerLottieRenderer(null);
});
```

Reset the registration in an `afterEach` — it is module-level state and will leak between tests otherwise.

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/paywall-renderer && npx vitest run`

- [ ] **Step 3: Implement**

Add the `case "video":` and `case "lottie":` arms. Both consume `useNodeVisible` and pass `playing` down; the video pauses via its element's `pause()`/`play()` rather than remounting. An absent `aspectRatio` sets no CSS ratio at all, letting the source's own dimensions govern. Put every literal (dot sizes, default ratios if any) in named constants in `styles.ts`.

A video whose source fails renders `fallback` else nothing — the same rule as every other node, and inside a carousel it means no phantom dot.

- [ ] **Step 4: Run the web suite**

Run: `cd packages/paywall-renderer && npx vitest run`
Expected: all green.

- [ ] **Step 5: Mutation-check**

Make `registerLottieRenderer`'s handler ignored (always render `fallback`) and confirm the "hands a registered renderer" test fails. Restore. Hard-code `muted={false}` and confirm the defaults test fails. Restore.

State plainly what jsdom cannot prove: it does not play media, so autoplay actually starting, pausing on scroll, and audio genuinely stopping are browser-smoke items.

- [ ] **Step 6: Commit**

```bash
git add packages/paywall-renderer/src
git commit -m "feat(paywall-renderer): play video, and delegate lottie to a registered renderer"
```

---

### Task 5: iOS visibility detector, and move `countdown` + `carousel` onto it

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/PaywallUI/NodeVisibility.swift`
- Modify: `packages/sdk-swift/Sources/Rovenue/PaywallUI/RovenuePaywallView.swift` (`CountdownView` at `:1155`, `CarouselView` at `:1363`)
- Test: `packages/sdk-swift/Tests/RovenueTests/PaywallRenderSupportTests.swift`

**Interfaces:**
- Produces: `func isNodeOnScreen(nodeFrame: CGRect, viewportFrame: CGRect) -> Bool` (pure), and a `NodeVisibilityModifier` that composes it with `scenePhase`.

**This is the riskiest task in the wave.** SwiftUI has no `IntersectionObserver`. The approach: a `GeometryReader` background reporting the node's frame in a **named coordinate space** anchored on the paywall's `ScrollView`, compared against that scroll view's own frame. Both halves compose: on-screen AND app-in-front.

Keep the pure geometry decision separate from the plumbing — the decision is testable on every platform and must be; the plumbing that feeds it real rects is not.

- [ ] **Step 1: Write the failing tests**

```swift
func test_nodeFullyInsideTheViewportIsOnScreen() {
    XCTAssertTrue(isNodeOnScreen(
        nodeFrame: CGRect(x: 0, y: 100, width: 300, height: 200),
        viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 600)))
}

func test_nodeScrolledFullyAboveTheViewportIsOffScreen() {
    XCTAssertFalse(isNodeOnScreen(
        nodeFrame: CGRect(x: 0, y: -300, width: 300, height: 200),
        viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 600)))
}

func test_partiallyVisibleNodeCountsAsOnScreen() {
    XCTAssertTrue(isNodeOnScreen(
        nodeFrame: CGRect(x: 0, y: 550, width: 300, height: 200),
        viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 600)))
}

func test_aZeroSizedViewportFailsOpen() {
    XCTAssertTrue(isNodeOnScreen(
        nodeFrame: CGRect(x: 0, y: 0, width: 300, height: 200),
        viewportFrame: .zero))
}
```

The last one matters: before first layout the viewport is `.zero`, and treating that as "off-screen" would stop every timer at launch. **Fail open**, matching the web's documented behaviour.

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/sdk-swift && swift test`

- [ ] **Step 3: Implement `NodeVisibility.swift`**

The pure predicate plus the modifier that supplies real frames. Any threshold (e.g. "counts as on-screen when at least N points intersect") is a named constant, not an inline literal.

- [ ] **Step 4: Move both existing consumers onto it**

`CountdownView` and `CarouselView` drop their bespoke pause logic and use the modifier. The carousel's `loop: false` stop-latch must survive a pause/resume cycle — pausing is not reaching the end.

- [ ] **Step 5: Run the Swift suite**

Run: `cd packages/sdk-swift && swift test`
Expected: all green (was 249 passing).

**SourceKit/IDE diagnostics in this repo have been stale and wrong nine times this session**, every one contradicted by a green `swift test`. Trust the build, not the editor.

- [ ] **Step 6: Mutation-check**

Invert the predicate's containment test and confirm the off-screen test fails. Restore. Then state plainly what cannot be tested: whether the modifier is fed real frames by SwiftUI at all is device-only — the predicate is pinned, the plumbing is a smoke item.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-swift/Sources packages/sdk-swift/Tests
git commit -m "feat(sdk-swift): one visibility rule for every time-driven node"
```

---

### Task 6: iOS `video` and `lottie`

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/PaywallUI/RovenuePaywallLottie.swift`
- Modify: `.../BuilderConfigModel.swift`, `RovenuePaywallView.swift`, `PaywallOverrides.swift`
- Test: `packages/sdk-swift/Tests/RovenueTests/BuilderConfigModelTests.swift`, `PaywallRenderSupportTests.swift`

**Interfaces:**
- Consumes: `isNodeOnScreen` / the modifier from Task 5; the fixture cases and `defaults` keys from Task 1.
- Produces: `public func registerLottieRenderer(_ render: ((LottieRenderRequest) -> AnyView)?)` and `public struct LottieRenderRequest { public let url: URL; public let loop: Bool; public let autoplay: Bool; public let speed: Double; public let playing: Bool }`.

Playback is `AVPlayer` — no AVKit beyond it, no new dependency. Fixture entries are selected **by name**, never index. The nine new `defaults` keys each get a **by-value** comparison in the existing sync test; if a constant you need is `private`, widen it to `let` (Swift's `private` is file-scoped and even `@testable import` cannot cross it — this project hit that once already).

- [ ] **Step 1: Write the failing tests**

```swift
func test_decodesBareVideoFromTheSharedFixture() throws {
    let node = try decodeNodeNamed("video-bare")
    guard case .video(let p) = node else { return XCTFail("expected video") }
    XCTAssertNil(p.autoplay)
    XCTAssertNil(p.posterUrl)
}

func test_nativeMediaDefaultsMatchTheSharedFixtureByValue() throws {
    let defaults = try fixtureDefaults()
    XCTAssertEqual(videoDefaultMuted, defaults["VIDEO_DEFAULT_MUTED"] as? Bool)
    XCTAssertEqual(lottieDefaultSpeed, defaults["LOTTIE_DEFAULT_SPEED"] as? Double)
}

func test_aLottieNodeWithNoRegisteredRendererHasNothingToDraw() throws {
    registerLottieRenderer(nil)
    XCTAssertNil(lottieContentView(props: bareLottieProps, playing: true))
}
```

Add the defaults assertions into the EXISTING by-value test rather than a new one. Reset the registration in `tearDown` — it is process-level state.

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/sdk-swift && swift test`

- [ ] **Step 3: Implement**

`BuilderConfigModel.swift`: the `video`/`lottie` cases, their props, lenient decode, and the mirrored constants with a comment noting they mirror `schema.ts` by hand.
`RovenuePaywallLottie.swift`: the registration point and `LottieRenderRequest`.
`RovenuePaywallView.swift`: the two views, both driven by Task 5's visibility modifier.
`PaywallOverrides.swift`: the `url`/`posterUrl` override keys.

- [ ] **Step 4: Run the Swift suite**

Run: `cd packages/sdk-swift && swift test`
Expected: all green.

- [ ] **Step 5: Mutation-check**

Change the mirrored `videoDefaultMuted` to `false` and confirm the by-value sync test fails. Restore.

State plainly what is device-only: `AVPlayer` actually starting, pausing on scroll, and audio genuinely stopping cannot be observed from a unit test.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-swift/Sources packages/sdk-swift/Tests
git commit -m "feat(sdk-swift): play video, and delegate lottie to a registered renderer"
```

---

### Task 7: Android visibility detector, and move `countdown` + `carousel` onto it

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/NodeVisibility.kt`
- Modify: `.../paywallui/NodeViewFactory.kt` (the countdown row that ticks at `COUNTDOWN_TICK_MS` around `:1476-1510`; `CarouselPagerView` at `:1562`)
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/NodeVisibilityTest.kt`

**Interfaces:**
- Produces: a pure on-screen predicate plus an internal helper wiring it to `ViewTreeObserver.OnScrollChangedListener` and the existing `ProcessLifecycleOwner` signal.

> **Amended after implementation.** This originally specified
> `isNodeOnScreen(visibleRect: Rect?, viewWidth: Int, viewHeight: Int)`, taking an Android
> `Rect`. That signature made the predicate **untestable**: under this module's mockable
> `android.jar`, `Rect(0, 0, 300, 200)` constructs with every field at `0` and `isEmpty()`
> returns `false` — the opposite of the truth for an all-zero rect. The on-screen branch was
> therefore unreachable from any JVM test and passed only because the stub's default happened
> to agree, which mutation checking cannot detect (test and code lean on the same default
> rather than disagreeing). The predicate now takes plain integers the JVM can produce, with a
> thin adapter reading a real `Rect` at the call site. Proof the change bought something: the
> `return true` mutation, which previously passed the entire suite, now fails five tests.
> **Probe a stubbed type before writing a test that depends on it behaving like the real one.**

Keep this module's split: pure logic in JVM-testable helpers, view construction smoke-tested. **Do not add Robolectric** — it was removed because the JUnit5-platform test tasks could never discover its JUnit4-style tests.

`ProcessLifecycleOwner.get()` is already obtained fail-soft via `runCatching` in this file; the new detector must keep that property. A paywall must never crash a host app over an optional lifecycle observer.

- [ ] **Step 1: Write the failing tests**

The test bodies below are written against the ORIGINAL `Rect`-taking signature and did not
survive implementation — see the amendment above. Two of them (`a fully visible view is on
screen`, `a partially visible view counts as on screen`) could not actually exercise what they
claimed and were replaced once the predicate took plain integers. They are kept here only to
show what was tried; write the equivalents against the integer signature.

```kotlin
@Test fun `a view with no visible rect is off screen`() {
    assertFalse(isNodeOnScreen(null, viewWidth = 300, viewHeight = 200))
}

@Test fun `an unmeasured view fails open`() {
    assertTrue(isNodeOnScreen(null, viewWidth = 0, viewHeight = 0))
}
```

The last one matters and takes precedence over the second: before layout there is no visible rect and no size, and treating that as off-screen would stop every timer at attach. **Fail open**, matching web and iOS. Order your implementation so the unmeasured case is decided before the null-rect case, or the two tests contradict each other.

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests '*NodeVisibilityTest*'`

- [ ] **Step 3: Implement `NodeVisibility.kt`**

The pure predicate plus the listener wiring. Any threshold is a named constant.

- [ ] **Step 4: Move both existing consumers onto it**

The countdown row and `CarouselPagerView` drop their bespoke pause logic. Both already post and remove their own `Handler` in their own `onAttachedToWindow`/`onDetachedFromWindow` — keep that shape; the detector supplies an additional pause signal, it does not replace lifecycle teardown. The carousel's `loop: false` stop-latch must survive a pause/resume cycle.

Every listener registered must be unregistered on detach. `render()` runs on every package tap, so a leak here accumulates for the life of the view — that exact defect has already shipped once in this file.

- [ ] **Step 5: Run the Kotlin suite**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: all green (was 325 tests, 0 failures). **Not a compile task** — `compileReleaseKotlin` only builds main and misses red tests. Read the count from the summed JUnit XML.

- [ ] **Step 6: Mutation-check**

Make `isNodeOnScreen` always return `true` and confirm the off-screen test fails. Restore. Then state plainly what is device-only: whether `OnScrollChangedListener` fires with real rects is not observable under the stub `android.jar`.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-kotlin/src
git commit -m "feat(sdk-kotlin): one visibility rule for every time-driven node"
```

---

### Task 8: Android `video` and `lottie`

**Files:**
- Modify: `.../paywallui/{BuilderConfigModel,NodeViewFactory,PaywallOverrides}.kt`
- Test: `.../paywallui/{BuilderConfigModelTest,NodeViewFactoryTest}.kt`

**Interfaces:**
- Consumes: `isNodeOnScreen` and the wiring from Task 7; the fixture cases and `defaults` keys from Task 1.
- Produces: `fun registerLottieRenderer(render: LottieRenderer?)` and `fun interface LottieRenderer { fun createView(context: Context, request: LottieRenderRequest): View? }`, plus `data class LottieRenderRequest(val url: String, val loop: Boolean, val autoplay: Boolean, val speed: Double, val playing: Boolean)`.

Playback is `MediaPlayer` on a `TextureView` — **no ExoPlayer**, no new dependency. Fixture entries selected **by name**, never index; the nine new `defaults` keys each get a **by-value** comparison in the existing sync test.

- [ ] **Step 1: Write the failing tests**

```kotlin
@Test fun `decodes the bare video from the shared fixture`() {
    val node = decodeFixtureNode("video-bare")
    assertTrue(node is BuilderNode.Video)
    assertNull((node as BuilderNode.Video).autoplay)
}

@Test fun `native media defaults match the shared fixture by value`() {
    val defaults = fixtureDefaults()
    assertEquals(defaults["VIDEO_DEFAULT_MUTED"], VIDEO_DEFAULT_MUTED)
    assertEquals(defaults["LOTTIE_DEFAULT_SPEED"], LOTTIE_DEFAULT_SPEED)
}

@Test fun `a lottie node with no registered renderer has no view to build`() {
    registerLottieRenderer(null)
    assertNull(lottieViewOrNull(context = stubContext, request = bareLottieRequest))
}
```

`decodeFixtureNode`/`fixtureDefaults` may not exist yet — a previous wave added them as thin wrappers over this module's real machinery (`entryNamed`/`configJson`/`decodeBuilderConfig`). Reuse them if present, add them in that shape if not. Reset the registration in a teardown; it is process-level state.

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`

- [ ] **Step 3: Implement**

`BuilderConfigModel.kt`: `BuilderNode.Video` / `BuilderNode.Lottie`, lenient decode, mirrored constants with a sync comment.
`NodeViewFactory.kt`: the two builders, both driven by Task 7's detector; the registration point and its types.
`PaywallOverrides.kt`: the `url`/`posterUrl` override keys.

- [ ] **Step 4: Run the Kotlin suite**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: all green.

- [ ] **Step 5: Mutation-check**

Change the mirrored `VIDEO_DEFAULT_MUTED` and confirm the by-value sync test fails. Restore. Make `registerLottieRenderer` ignored and confirm the no-renderer test fails. Restore.

State plainly what is device-only: `MediaPlayer` actually starting, pausing on scroll, and audio genuinely stopping are not observable under the stub `android.jar`.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-kotlin/src
git commit -m "feat(sdk-kotlin): play video, and delegate lottie to a registered renderer"
```

---

### Task 9: Device and browser smoke session

**Human-only.** Not dispatchable to a subagent, and the wave does not close without it. Every task above ends by naming what its tests could not prove; those items land here.

Before this session, review Tasks 3–8 **together, in one review** — and review the **authoring surface separately**, because when the three renderers agree, a feature none of them can be fed still looks correct. That is how a `stickyFooter` the builder could not populate survived a full wave.

- [ ] **All three — the detector, which is this wave's point.** Scroll a playing video out of view and back. Confirm playback stops and resumes, and that **audio** stops, not just the picture. Then confirm a `countdown` and a `carousel` on the same paywall behave identically to the video — that is the retrofit's whole purpose.
- [ ] **All three** — background the app and return, for all four node types.
- [ ] **All three** — a `lottie` node with no handler registered shows its `fallback`; register one and it animates.
- [ ] **All three** — a video with `autoplay: true, muted: false`: confirm web refuses to autoplay while both natives do, which is the divergence `VIDEO_AUTOPLAY_UNMUTED` exists to warn about.
- [ ] **All three** — a video whose URL 404s renders `fallback`, and inside a carousel leaves no phantom dot.
- [ ] **Cellular** — leave an off-screen video's paywall open for two minutes and confirm data usage does not climb.
- [ ] **iOS specifically** — the `GeometryReader` coordinate-space plumbing is the wave's highest-risk piece and its unit tests cover only the pure predicate. Verify frames are actually reported: a node near the fold should flip state exactly as it crosses.

---

## Self-Review

**Spec coverage:** §2 detector → Tasks 3, 5, 7. §2.1 retrofit → the same three tasks, each moving `countdown` and `carousel` in the same commit as the detector, so a reviewer cannot approve one without the other. §3 `video` → Tasks 1, 4, 6, 8. §3.1 autoplay/muted → Task 1's validator plus the Task 9 smoke item. §3.2 failed source → Tasks 4, 6, 8. §3.3 `ThemeUrl` → Task 1 Step 3. §4 `lottie` and the seam → Tasks 1, 4, 6, 8. §5 defaults → Task 1, with by-value native comparisons in Tasks 6 and 8. §6 validator → Task 1. §7 testing → every task's mutation-check step plus Task 9. §8 rule 1 (`inspector/tabs.ts`) → Task 2's file list; rule 4 (authoring surface reviewed separately) → Task 9's preamble.

**Type consistency:** `ThemeUrl`, `VideoNode`, `LottieNode`, the nine constants, `useNodeVisible`, `isNodeOnScreen`, `LottieRenderRequest`, `registerLottieRenderer` — each defined once and used with the same name throughout. The three platforms' `LottieRenderRequest` carry the same five fields (`url`, `loop`, `autoplay`, `speed`, `playing`) so the seam reads the same everywhere.

**Gaps found and closed during review:** (1) Task 2 originally omitted `tree-ops.ts`; `video` and `lottie` are leaves and need no container handling, but they still need `newNode` cases or the palette creates nothing — added to Step 3. (2) Task 7's "fails open" and "no visible rect" tests contradicted each other until the ordering requirement was stated explicitly; the plan now says which case must be decided first. (3) Task 1's bounds test references the constants it guards, so it cannot detect a change to their values — the note now says so, and points at the fixture assertions that do pin them.
