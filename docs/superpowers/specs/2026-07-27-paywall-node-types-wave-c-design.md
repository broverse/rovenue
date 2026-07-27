# Paywall node types, wave C: scrollable content, `stickyFooter`, `countdown`

**Date:** 2026-07-27
**Status:** Approved, ready for planning
**Parent:** P4b in `2026-07-23-paywall-builder-gap-analysis.md`
**Depends on:** wave A and wave B, both shipped

---

## 1. What this delivers, and why it is three things

The last of P4b's three waves. Waves A and B added node types that draw; this one adds the two
that *behave* — one that changes with time, one that changes its siblings' layout — plus the
scrolling that one of them presupposes.

**Scrolling is not a feature here, it is a bug fix.** None of the three renderers has a scroll
container today: no `overflow` in the web renderer, no `ScrollView` in SwiftUI, no
`NestedScrollView` on Android. The Swift root is a plain `VStack`; the Android root is a
`LinearLayout`. A paywall taller than the screen therefore has unreachable content on every
platform, including its purchase button. That is worth fixing on its own, and `stickyFooter` is
meaningless without it — "sticky" only means something if content passes beneath.

Worth recording plainly: the React Native bridge phase's device smoke checklist contained
"Scrolling works through the full content" and was reported as passed. No scroll container
exists, so that item cannot have been exercised as written — most likely the host app supplied
its own scroll view, or the test paywall fit on screen. The pass stands for the other items; this
one was not covered.

---

## 2. Scrollable content

Each renderer's root gains a scroll container. No configuration flag: a short paywall in a
scroll container simply does not scroll, and a flag would be one more thing to get wrong.

### 2.1 The trap that must not be got wrong

A vertical stack inside a scroll container **stops filling the screen**. Available height
becomes unbounded, so a flexible `spacer` collapses and a stack that distributed its children
across the viewport now hugs the top. Every existing paywall that pushes its CTA to the bottom
would silently change.

The fix is the same idea on all three platforms: give the scrolled content a **minimum height
equal to the viewport**, so short content still fills and distributes while long content
scrolls.

| | Mechanism |
|---|---|
| web | `min-height: 100%` on the inner container, with the scroller at `height: 100%` |
| SwiftUI | `GeometryReader` around the `ScrollView`, content `.frame(minHeight: proxy.size.height)` |
| Android | `NestedScrollView` with `android:fillViewport="true"` |

This is the single highest-risk change in the wave, and **no existing test would catch getting
it wrong** — the tree still renders, every assertion still passes, and only the vertical
distribution changes. It therefore needs both a per-platform test that a short paywall's content
still occupies the full height, and an explicit device-smoke item.

---

## 3. `stickyFooter`

```ts
type StickyFooterNode = {
  type: "stickyFooter";
  id: string;
  children: PaywallNode[];
  background?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

It is a **node type**, not a new top-level field on `BuilderConfig`, and the reason is backward
compatibility. An older SDK does not know the type, so it renders the node's `fallback` — the
existing unknown-type machinery — and the footer's contents appear inline at the bottom. Had it
been a sibling field, an older SDK would ignore it silently and a paywall whose purchase button
lives in the footer would render **with no way to buy**.

The cost is that one child gets special treatment: the renderer lifts it out of the scrolled
content and pins it. That magic is bounded by three rules, enforced by the validator:

- Only a **direct child of `root`** may be a sticky footer. Nested elsewhere it renders inline
  like any stack, and the validator raises `STICKY_FOOTER_NOT_AT_ROOT` (a `warning` — it still
  draws, just not pinned).
- If there is **more than one**, the last wins and the others render inline;
  `MULTIPLE_STICKY_FOOTERS` (a `warning`).
- The footer sits **above the bottom safe area**, never under the home indicator, and the
  scrolled content gets bottom padding equal to the footer's height so the last item is never
  hidden beneath it. Getting that padding wrong is invisible to tests and belongs on the smoke
  checklist.

---

## 4. `countdown`

The first node whose output changes over time.

```ts
type CountdownNode = {
  type: "countdown";
  id: string;
  /** Absolute deadline, ISO-8601. Mutually exclusive with durationSeconds. */
  endsAt?: string;
  /** Seconds from the first time this paywall is shown to this user.
   *  Mutually exclusive with endsAt. */
  durationSeconds?: number;
  /** What to show once the deadline passes. Defaults to COUNTDOWN_DEFAULT_ON_EXPIRY. */
  onExpiry?: "freeze" | "hide";
  labelKey?: string;
  color?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

### 4.1 Two modes, deliberately

Exactly one of `endsAt` and `durationSeconds` is required; the schema enforces the exclusivity
and the validator raises `COUNTDOWN_NO_DEADLINE` (a **`publish`**-tier issue — a countdown with
no deadline is not a work-in-progress, it cannot render at all) when neither is present.

Both exist because neither alone is sufficient. `endsAt` is honest and suits a genuine dated
promotion, but a paywall that stays live outruns it — hence `COUNTDOWN_DEADLINE_PAST`, a
`warning` raised at authoring time when the date has already gone. `durationSeconds` suits an
evergreen paywall and needs no maintenance, at the cost of being urgency the author manufactures
rather than reports.

`durationSeconds` counts from **first show per user**, persisted, not from each view — a timer
that restarts on every open is not a deadline and users notice.

### 4.2 Expiry is a policy, so it is a field

`onExpiry` defaults to **`freeze`**: the countdown stays at zero. `hide` removes the node, which
collapses whatever space it occupied — sensible when the countdown sits alone, jarring mid-page.
Defaulting to `hide` would make a layout jump the out-of-the-box behaviour.

### 4.3 The timer must stop when nobody is looking

A one-second tick, and on all three platforms it must stop when the paywall is off-screen and
resume when it returns. A timer that survives backgrounding is a battery complaint and, on
Android, a leaked view reference. This is behaviour no unit test in this repo can observe, so it
is a smoke-checklist item on each platform.

---

## 5. Defaults, declared once

Continuing wave B's rule — and wave C's own lesson in §6 — every absent-prop behaviour is a
shared constant:

| Constant | Value | Applies to |
|---|---|---|
| `COUNTDOWN_DEFAULT_ON_EXPIRY` | `"freeze"` | a countdown with no `onExpiry` |
| `COUNTDOWN_TICK_MS` | `1000` | the tick interval on all three platforms |
| `STICKY_FOOTER_DEFAULT_BACKGROUND` | the surface colour pair | a footer with no `background` |

A countdown's absent `color` **inherits** the ambient text colour, expressed as the absence of a
colour instruction — not a substituted value.

---

## 6. Binding rules carried forward

The first four come from waves A and B and remain in force. The fifth is new, and it is the
sharpest lesson this project has produced.

1. **Pair a node type's obligations in one task** — `OVERRIDABLE_PROP_KEYS`, `LOCALIZED_KEYS`,
   every per-type dispatcher, and the inspector fields those override keys imply.
2. **No `default` branch in a TypeScript per-type dispatcher.** Use an exhaustiveness check.
3. **Every optional prop's absent-value behaviour is a shared constant**, or explicitly
   "inherit", decided once.
4. **Review the three renderers together, in one review.** Both Criticals in wave A and both in
   wave B came from that comparison; none would have surfaced in a task-scoped review.
5. **A rule verified by reading code is not a verified outcome.** In wave B the rule "never
   substitute a value for an absent colour" was honoured exactly in the Kotlin — it never called
   `imageTintList` — and Android still drew white marks, because the substituted value had moved
   into the vendored asset. Where a rule governs what the user *sees*, the check must reach the
   rendered result: a test that inspects the resolved value, or a smoke item, not a reading of
   the branch.

Rule 5 binds this wave harder than the others, because scroll fill, footer padding and timer
lifecycle are all invisible to the tests this repo can run.

---

## 7. Testing

- **Shared:** schema round-trips; the `endsAt`/`durationSeconds` exclusivity in both directions;
  the four new issue codes and their tiers; `LOCALIZED_KEYS` rows.
- **Per renderer:** a short paywall's content still fills the viewport under the scroll
  container; a sticky footer is excluded from the scrolled content and the content carries
  bottom padding for it; a nested sticky footer renders inline; a countdown formats a known
  remaining time; `onExpiry: "hide"` removes the node and `"freeze"` holds it at zero.
- **Cross-platform:** the three renderers reviewed together against one checklist of what each
  draws for the same node with every optional prop absent.
- **Device smoke, a deliverable rather than a follow-up.** Scroll fill on a short and a long
  paywall; the footer clearing the home indicator; the last content item not hidden beneath the
  footer; the timer stopping on background and resuming on return; and the countdown surviving a
  minute of real ticking without drift or a retain cycle.

---

## 8. Out of scope

- P4c's media types (`carousel`, `video`).
- Horizontal scrolling, and any scroll configuration surface — the container is unconditional.
- A server-supplied deadline. `countdown` carries its own; wiring it to a real promotion is a
  commerce concern and belongs with P6.
