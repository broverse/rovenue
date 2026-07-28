# Paywall node types, wave D1: `carousel`, and the image substrate it stands on

**Date:** 2026-07-28
**Status:** Approved, ready for planning
**Parent:** P4c in `2026-07-23-paywall-builder-gap-analysis.md`
**Depends on:** P4b (waves A, B and C — all shipped)
**Sibling:** wave D2 (`video`, `lottie`, the media-lifecycle contract) — planned separately

---

## 1. Why P4c is two waves, and why this one comes first

P4c as written is `carousel` plus `video`/`lottie`. That is three node types, a substrate fix, and a
new extension mechanism — roughly twice wave C, which needed seven tasks for two node types plus
scrolling. Splitting is not caution; it is the same boundary the work already has.

**D1 is about pixels arriving on screen: horizontal paging and image loading.** **D2 is about time:
video playback, Lottie animation, and the one lifecycle contract all time-driven media must share.**
Each ships working, testable software alone.

D1 comes first because `carousel` is the node type that makes the existing image path's weakness
consequential, and because horizontal scrolling is a mechanism none of the three renderers has.

---

## 2. The substrate fix, which is not optional

Android's image loader (`NodeViewFactory.kt:1328`, `loadImageInto`) opens a raw `HttpURLConnection`
and calls `BitmapFactory.decodeStream` on every invocation. There is **no cache and no
downsampling**. Two existing facts turn that into a real defect the moment a carousel exists:

1. The Android renderer rebuilds its **entire view tree on every state change** — a deliberate,
   documented choice (`RovenuePaywallView.kt:42-50`) that keeps cell-scoped variable text correct.
   `render()` therefore runs on **every package tap**.
2. A carousel holds N pages.

So a five-image carousel costs five full network fetches and five full-size bitmap decodes per tap.
Adding `carousel` on top of this path without fixing it ships a known performance defect.

**This is Android-only.** The web `<img>` (`nodes.tsx:255`) uses the browser cache, and SwiftUI's
`AsyncImage` (`RovenuePaywallView.swift:664`) uses the shared `URLSession` cache. Android is the
outlier because it hand-rolls the fetch.

The fix is the smallest thing that removes the defect:

- an in-memory **LRU bitmap cache keyed by URL**, bounded by a named constant, so a rebuild is a
  map lookup rather than a fetch;
- **downsampling to the target view size** via `BitmapFactory.Options.inSampleSize`, so a 2000 px
  hero is not decoded at full size into a 300 px slot.

No disk cache and no third-party image library. Coil was deliberately excluded from this module and
stays excluded; this adds no dependency.

---

## 3. `carousel`

```ts
type CarouselNode = {
  type: "carousel";
  id: string;
  /** Pages. Any node, not only images — the same freedom `stack` gives. */
  children: PaywallNode[];
  /** Page dots. Defaults to CAROUSEL_DEFAULT_SHOWS_INDICATOR. */
  showsIndicator?: boolean;
  /** Seconds between automatic advances. Absent = no auto-advance. */
  autoAdvanceSeconds?: number;
  /** Wrap past the last page. Defaults to CAROUSEL_DEFAULT_LOOP. */
  loop?: boolean;
  /** Dot colour. Absent inherits the ambient text ink. */
  indicatorColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

Pages are arbitrary nodes rather than a dedicated image list. A carousel of feature panels — image
plus heading plus body — is the common case, and restricting children to images would force authors
into a parallel structure the builder already expresses with `stack`.

### 3.1 Horizontal paging, per platform

Wave C added vertical scrolling and explicitly deferred horizontal. This is that work.

| | Mechanism | Why this one |
|---|---|---|
| web | flex row, `scroll-snap-type: x mandatory`, each page `scroll-snap-align: center` | Native snapping, no JS scroll maths, no library |
| iOS | `TabView` with `.tabViewStyle(.page)` | Available since iOS 14, well under our iOS 16 floor, and supplies paging **and** dots. `ScrollView.scrollTargetBehavior(.paging)` is iOS 17+ and unusable here |
| Android | `androidx.viewpager2` | See below |

**ViewPager2 is the one new dependency this wave adds**, and it is worth stating plainly rather than
burying. The alternative is a `HorizontalScrollView` with hand-written snapping, page tracking, dot
synchronisation and auto-advance — three mechanisms this repo would then own and debug on devices.
ViewPager2 is a small androidx artifact, our `minSdk` is 24 against its floor of 14, and it is what
the platform expects. Hand-rolling paging is exactly the category of work that produces defects only
a device reveals, which wave C spent a full review round learning.

### 3.2 The indicator

`showsIndicator` defaults to on. iOS gets dots from `TabView` free; web and Android draw them. An
absent `indicatorColor` **inherits** the ambient text ink — expressed as the absence of a colour
instruction, never a substituted value.

That rule already has a scar. In wave B the Kotlin honoured "never substitute" exactly in its branch
and Android still drew the wrong colour, because the substituted value had moved into a vendored
drawable asset. The dots are drawn shapes, so the same trap is available here: verify at the
**resolved colour**, not at the branch.

### 3.3 Auto-advance is a timer, with all that implies

`autoAdvanceSeconds` is absent by default, and absent means off. When present it must obey the same
lifecycle contract wave C established for `countdown`:

- stops when the carousel is off-screen, resumes when it returns;
- never leaks a handler, timer or observer past the view's life;
- a user swipe **restarts the interval** rather than racing it — advancing 200 ms after someone
  swipes by hand feels broken;
- with `loop: false`, auto-advance **stops permanently on reaching the last page** and does not
  rewind. With `loop: true` it wraps to the first. Left unstated, this is precisely the kind of gap
  three renderers fill three different ways — one would rewind, one would stop, one would keep
  firing against a clamped index.

Wave C shipped a divergence here that is still open (parked finding NEW-3: after a countdown
expires, web stops its interval, iOS keeps its `Timer`, Android keeps re-posting). D1 must not add a
second instance of that. The lifecycle is written once, in §5, and all three implement that text.

---

## 4. Defaults, declared once

Continuing waves B and C: every absent-prop behaviour is a shared constant in
`packages/shared/src/paywall/schema.ts`, or explicitly "inherit".

| Constant | Value | Applies to |
|---|---|---|
| `CAROUSEL_DEFAULT_SHOWS_INDICATOR` | `true` | a carousel with no `showsIndicator` |
| `CAROUSEL_DEFAULT_LOOP` | `false` | a carousel with no `loop` |
| `CAROUSEL_MIN_AUTO_ADVANCE_SECONDS` | `2` | the validator floor, §6 |
| `IMAGE_CACHE_MAX_ENTRIES` | `32` | the Android LRU bound, §2 |

`indicatorColor` absent **inherits**. `autoAdvanceSeconds` absent means **off** — not a default
interval, because a paywall that starts moving on its own without the author asking is a surprise.

`render-fixtures.json` gains `carousel` cases and the new `defaults` keys. It is the **three**-platform
decoder contract, and each native's by-value sync test enumerates the defaults block explicitly —
so every new key needs a line in each, or it is pinned for web only. That gap was found and closed
once already this project (finding NEW-4); do not reopen it.

---

## 5. The timer lifecycle contract, written once

Three platforms, one text. Any time-driven node — today `countdown` and `carousel`'s auto-advance,
tomorrow D2's video and Lottie — obeys all four:

1. **Off-screen means paused.** Not throttled, not running-into-the-void.
2. **On-screen means resumed**, without requiring a full re-render to restart.
3. **Nothing outlives the view.** No handler, timer, observer or player survives teardown.
4. **The tick is a repaint trigger, never the source of truth.** State is computed from the clock or
   from an index, so a missed or delayed tick corrects itself rather than accumulating drift.

Rule 4 is not theoretical: wave C's web countdown advanced by counting ticks, so it drifted, stalled
in a background tab, and jumped forward by the whole elapsed time whenever a package tap re-rendered
the tree. Rule 4 is what that finding cost.

---

## 6. Validator issues

| Code | Tier | Raised when |
|---|---|---|
| `CAROUSEL_EMPTY` | `publish` | `children` is empty — a carousel with no pages cannot render at all |
| `CAROUSEL_AUTO_ADVANCE_TOO_FAST` | `warning` | `autoAdvanceSeconds` below `CAROUSEL_MIN_AUTO_ADVANCE_SECONDS` — legible, but the author probably meant otherwise |
| `CAROUSEL_SINGLE_PAGE` | `warning` | exactly one child — paging and dots are meaningless; likely a stack was intended |

`LOCALIZED_KEYS` gains its `carousel` row. That type is exhaustive and mapped, so a missing row is a
compile error rather than a silent gap — the property waves A–C paid for and must keep.

---

## 7. Testing

- **Shared:** schema round-trips; the three issue codes and their tiers; `LOCALIZED_KEYS`;
  `render-fixtures.json` accept/lenient cases; the new `defaults` keys compared **by value** in all
  three platforms' sync tests.
- **Android substrate:** the LRU cache is pure, JVM-testable logic — a second load of the same URL
  must not re-fetch, eviction must respect the bound, and `inSampleSize` selection must be tested
  against target sizes. This is the one part of D1 that is genuinely unit-testable, so it gets real
  tests rather than a smoke item.
- **Per renderer:** a carousel renders each child once; an empty carousel renders `fallback` else
  nothing; `showsIndicator: false` draws no dots; a single-page carousel does not crash; an absent
  `indicatorColor` resolves to the ambient ink.
- **Cross-platform:** the three renderers reviewed **together, in one review**. Both Criticals in
  wave A, both in wave B, and nine of eighteen findings in wave C came only from that comparison.
  None would have surfaced in a task-scoped review.
- **Device smoke, a deliverable rather than a follow-up.** Paging feel and snapping on each platform;
  dots tracking the real page; auto-advance stopping off-screen and resuming; a hand swipe resetting
  the interval; and — the substrate item — tapping between packages 20–30 times with a five-image
  carousel on screen while watching the network, which must show fetches only on the first pass.

---

## 8. Binding rules carried forward

The five from waves A–C remain in force. Restated because each was paid for:

1. **Pair a node type's obligations in one task** — `OVERRIDABLE_PROP_KEYS`, `LOCALIZED_KEYS`, every
   per-type dispatcher, the inspector fields those override keys imply, **and `inspector/tabs.ts`**.
   Wave B shipped two node types with no inspector at all because that last file was left off a task's
   file list.
2. **No `default` branch in a TypeScript per-type dispatcher.** Use an exhaustiveness check.
3. **Every optional prop's absent-value behaviour is a shared constant, or explicitly "inherit"**,
   decided once.
4. **Review the three renderers together, in one review.**
5. **A rule verified by reading code is not a verified outcome.** Where a rule governs what the user
   *sees*, the check must reach the rendered result — a test that inspects the resolved value, or a
   smoke item, never a reading of the branch.

A sixth, earned in wave C and worth writing down: **a test that passes with the feature broken is
worse than no test**, because it reports safety. Every claim a wave makes gets mutation-checked, and
where no test can catch a defect — jsdom computes no layout, SwiftUI structural tests expose
structure but not numbers, Android's JVM tests cannot observe a measure pass — that is **stated
plainly and moved to the smoke checklist**, not papered over.

---

## 9. Out of scope

- `video` and `lottie`, the plugin registration seam, and the media-lifecycle work — all wave D2.
- Vertical carousels, nested carousels, and any scroll-configuration surface beyond the props above.
- A disk image cache, and any third-party image library on Android.
- Server-driven carousel content. Pages come from the builder tree like every other node.
