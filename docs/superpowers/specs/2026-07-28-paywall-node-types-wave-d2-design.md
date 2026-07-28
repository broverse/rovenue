# Paywall node types, wave D2: `video`, `lottie`, and one lifecycle for all of them

**Date:** 2026-07-28
**Status:** Approved, ready for planning
**Parent:** P4c in `2026-07-23-paywall-builder-gap-analysis.md`
**Depends on:** P4b (waves A–C) and P4c wave D1 — all shipped
**Sibling:** wave D1 (`carousel` + the Android image substrate), shipped

---

## 1. What this is, and why it is not just two node types

D1 was about pixels arriving on screen. **D2 is about time.** It adds the two node types that keep
running after they are drawn — `video` and `lottie` — and it makes the lifecycle rule those imply
genuinely singular rather than a phrase repeated in three files.

That last part is the real deliverable. Wave C wrote a lifecycle contract; wave D1 implemented half
of it three times and left the other half open on both natives. Today a countdown pauses when the app
backgrounds but keeps running when it scrolls out of view, and a carousel does the same. Adding a
video — the one element where running unseen costs battery, data and, on cellular, money — to that
foundation without fixing it would ship the divergence permanently.

So D2 builds **one visibility detector per platform** and wires **four** consumers to it: `video`,
`lottie`, and retrofitted `countdown` and `carousel`.

---

## 2. The visibility detector, built once per platform

Every timer, player and animation in a paywall answers to the same question: *is this node actually
on screen right now?* Two signals compose into that answer, and both must be handled:

1. **The app is not in front** — already solved in D1: `visibilitychange` on web, `scenePhase` on
   iOS, `ProcessLifecycleOwner` on Android.
2. **The node has scrolled out of the viewport** — solved on web only (`IntersectionObserver`), and
   deferred on both natives because neither platform hands it over.

| | Mechanism | Note |
|---|---|---|
| web | `IntersectionObserver` + `visibilitychange` | already exists for `countdown`; extract and share |
| iOS | `GeometryReader` in a named coordinate space, compared against the scroll viewport | SwiftUI has no built-in equivalent; this is the wave's highest-risk piece |
| Android | `View.getLocalVisibleRect` on a scroll/layout listener, plus `ProcessLifecycleOwner` | `ViewTreeObserver.OnScrollChangedListener` is the trigger |

**This is the piece to build and prove first**, before any node type consumes it. It is also the
piece that no unit test on any of the three platforms can fully verify, so it carries the largest
share of the smoke checklist.

The detector is a shared internal facility, not a per-node-type reimplementation. If it ends up
written three times inside three node types on one platform, the wave has failed its own point.

### 2.1 The retrofit is part of this wave, not a follow-up

`countdown` and `carousel` move onto the detector in the same wave that introduces it. A video that
pauses off-screen next to a countdown that does not is precisely the divergence this project has paid
for repeatedly — and the marginal cost, once the detector exists, is wiring two more call sites per
platform.

---

## 3. `video`

```ts
type VideoNode = {
  type: "video";
  id: string;
  /** Theme-aware, like `image`'s url. See §4.1 on the `ThemeUrl` alias. */
  url: ThemeUrl;
  /** Shown before playback and while loading. Strongly advised — see §6. */
  posterUrl?: ThemeUrl;
  /** Absent = VIDEO_DEFAULT_AUTOPLAY. */
  autoplay?: boolean;
  /** Absent = VIDEO_DEFAULT_LOOP. */
  loop?: boolean;
  /** Absent = VIDEO_DEFAULT_MUTED. See §3.1 — this is not a free choice. */
  muted?: boolean;
  /** Absent = VIDEO_DEFAULT_SHOWS_CONTROLS. */
  showsControls?: boolean;
  /** Width ÷ height. Absent = the source's own ratio once known. */
  aspectRatio?: number;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

Playback uses each platform's **built-in** player — `<video>`, `AVPlayer`, and a `MediaPlayer` on a
`TextureView`. No ExoPlayer, no third-party media dependency. D1 already added the wave's one new
dependency (`androidx.viewpager2`) and the reasoning holds harder here: a subscription SDK should not
impose a media stack on every customer.

### 3.1 Autoplay implies muted, and that is a platform fact, not a preference

Browsers refuse to autoplay a video with sound. `VIDEO_DEFAULT_MUTED` is therefore `true`, and an
author who sets `autoplay: true` with `muted: false` gets a **`warning`**: the paywall will silently
fail to autoplay on web while autoplaying on both natives — a divergence the renderer cannot fix,
because one platform simply will not do it.

Stating this in the spec rather than leaving it to each renderer is deliberate: it is exactly the kind
of platform truth that, left unwritten, gets discovered separately three times.

### 3.2 A video that cannot play must not be a blank rectangle

If the source fails to load, the node falls back the way every other node does — its `fallback`, else
nothing. A poster, when given, shows during loading and after a failure. This is the same "a node that
draws nothing is dropped" rule D1 settled, and inside a `carousel` it means a dead video does not
leave a phantom dot.

---

### 3.3 `ThemeUrl` is introduced here

`image` today inlines its light/dark URL pair as `{ light: string; dark?: string }` with no name.
`video` and `lottie` need the same shape, and three anonymous copies of one type is how spellings
drift. This wave introduces `export type ThemeUrl = { light: string; dark?: string }` and moves
`image` onto it as well — a small, contained change in a file the wave is editing anyway, and the
same one-source-of-truth rule that governs the container predicate in the builder.

---

## 4. `lottie`, and the optional-dependency seam

```ts
type LottieNode = {
  type: "lottie";
  id: string;
  url: ThemeUrl;
  /** Absent = LOTTIE_DEFAULT_LOOP. */
  loop?: boolean;
  /** Absent = LOTTIE_DEFAULT_AUTOPLAY. */
  autoplay?: boolean;
  /** Playback rate multiplier. Absent = LOTTIE_DEFAULT_SPEED. */
  speed?: number;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

Lottie needs a third-party library on all three platforms, and most customers will never place a
Lottie node. So the SDK **knows the type but does not carry the library**:

- the schema, the validator, the builder and all three decoders understand `lottie` unconditionally;
- **rendering is delegated to a handler the host registers**;
- with no handler registered, the node renders its `fallback`, else nothing — the existing machinery,
  no new failure mode.

**Registration is explicit on every platform — one function call, no reflection and no class probing.**
Reflection would behave differently on each platform, fail in ways that are hard to test, and turn a
missing dependency into a runtime surprise instead of a decision the host made. Note this is genuinely
new public surface: the SDK façades have no user-facing registration point today.

A customer who wants Lottie adds the library and one line at startup. A customer who does not pays
nothing — no bytes, no version conflict with their own Lottie.

The registered handler must expose **play and pause**, because §2's detector drives it exactly as it
drives video.

---

## 5. Defaults, declared once

| Constant | Value | Applies to |
|---|---|---|
| `VIDEO_DEFAULT_AUTOPLAY` | `true` | a video with no `autoplay` |
| `VIDEO_DEFAULT_LOOP` | `true` | a video with no `loop` |
| `VIDEO_DEFAULT_MUTED` | `true` | a video with no `muted` — see §3.1 |
| `VIDEO_DEFAULT_SHOWS_CONTROLS` | `false` | a video with no `showsControls` |
| `LOTTIE_DEFAULT_LOOP` | `true` | a lottie with no `loop` |
| `LOTTIE_DEFAULT_AUTOPLAY` | `true` | a lottie with no `autoplay` |
| `LOTTIE_DEFAULT_SPEED` | `1` | a lottie with no `speed` |
| `LOTTIE_MIN_SPEED` | `0.1` | the validator floor, §6 |
| `LOTTIE_MAX_SPEED` | `4` | the validator ceiling, §6 |

`aspectRatio` absent means **the source's own ratio**, resolved once known — not a substituted number.
`posterUrl` absent means no poster.

`render-fixtures.json` gains `video` and `lottie` cases and these nine `defaults` keys. Each new key
needs a **by-value** comparison in the Swift AND Kotlin sync tests, or it is pinned for web only —
that gap has been opened and closed twice in this project already.

---

## 6. Validator issues

| Code | Tier | Raised when |
|---|---|---|
| `VIDEO_AUTOPLAY_UNMUTED` | `warning` | `autoplay` true and `muted` false — web will refuse to autoplay |
| `VIDEO_NO_POSTER` | `warning` | `autoplay` false and no `posterUrl` — the node is a blank rectangle until tapped |
| `LOTTIE_SPEED_OUT_OF_RANGE` | `warning` | `speed` outside `LOTTIE_MIN_SPEED`–`LOTTIE_MAX_SPEED` |

`LOCALIZED_KEYS` gains `video` and `lottie` rows — both `() => []`, since neither carries localized
text of its own. The mapped type is exhaustive, so a missing row is a compile error; keep it that way.

There is deliberately **no** authoring-time issue for "no Lottie handler registered". That is a
property of the host app at runtime, not of the paywall, and the validator cannot know it.

---

## 7. Testing

- **Shared:** schema round-trips; the three issue codes and their tiers; `LOCALIZED_KEYS` rows;
  fixture cases selected **by name**; the nine new `defaults` keys compared by value on all three.
- **The detector:** its pure decision logic — given a rect, a viewport and an app-foreground flag,
  should this node be running? — is testable on every platform and must be. The *plumbing* that feeds
  it real rects is not.
- **Per renderer:** a video renders its poster before playback; a failed source renders `fallback`;
  `showsControls` toggles the native controls; a `lottie` with no registered handler renders
  `fallback`; a registered handler is asked to play and pause as visibility changes.
- **Cross-platform:** the three renderers reviewed **together, in one review** — and, per D1's
  lesson, the **authoring surface reviewed separately**, because when the renderers agree, a feature
  none of them can be fed still looks correct.
- **Device smoke, a deliverable.** Scroll a playing video out of view and back on all three. Background
  and return. Confirm a countdown and a carousel now behave identically to the video. Confirm audio
  actually stops, not merely the picture. Watch data usage on cellular for an off-screen video.

---

## 8. Binding rules carried forward

The six from waves A–D1 remain. D1 added four more, each paid for:

1. Pair a node type's obligations in one task — including `inspector/tabs.ts`.
2. No `default` branch in a **builder** per-type dispatcher; use an exhaustiveness check. (A
   **renderer** dispatcher's `default` → `fallback` arm is correct and stays.)
3. Every optional prop's absent behaviour is a shared constant or explicitly "inherit".
4. Review the three renderers together — **and the authoring surface separately.**
5. A rule verified by reading code is not a verified outcome. **Verify the outcome the user sees, not
   the layer you changed** — a fix to the data layer with the UI still gated changes nothing on screen.
6. A test that passes with the feature broken is worse than no test. Mutation-check every claim.
7. **A test can encode the defect.** Twice in D1 a test pinned the wrong behaviour, so test and code
   agreed and both were wrong — mutation checking cannot catch that class. Only the cross-platform
   comparison did.
8. **Make the bad state unrepresentable rather than merely avoided.** D1's image loader waited on a
   dimension only the decode it was deferring could produce. The fix was not more care at the call
   site; it was changing the signature so the deadlock could not be written.
9. **A behaviour not written in the spec gets invented three times.** Both of D1's late divergences
   were rules that lived only in code comments.
10. Never describe a test you did not write. This is the one reporting failure treated as serious.

---

## 9. Out of scope

- Any third-party media stack: ExoPlayer, AVKit beyond `AVPlayer`, or a bundled Lottie.
- Video streaming formats beyond what the built-in players handle natively; no HLS/DASH work.
- Picture-in-picture, fullscreen, casting, captions, and audio-session/ducking policy.
- A Lottie handler shipped by Rovenue. The seam is ours; the library is the host's.
- Preloading or caching video. The image cache in D1 is for images.
