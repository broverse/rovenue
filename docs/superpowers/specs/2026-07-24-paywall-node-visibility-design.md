# Paywall Node Visibility (P5b) Design

**Date:** 2026-07-24
**Status:** Proposed. Feeds a writing-plans implementation plan for stage 1.
**Phase:** P5b of the paywall-builder redesign (gap analysis §4 row D). P5a shipped the tabbed inspector; this adds the fifth tab and the model behind it.

---

## 1. Verified terrain

Checked before writing, because three earlier phases in this project over-predicted infrastructure that turned out not to exist:

| Claim | Reality |
|---|---|
| `visibility` / `minAppVersion` / `maxAppVersion` exist anywhere | **No.** Absent from `packages/shared/src/paywall/`, all four renderers, and `render-fixtures.json`. |
| The renderers know which platform they are on | **No.** `RenderCtx` (`packages/paywall-renderer/src/nodes.tsx:35`) carries config, offering, locale, colour scheme, price view, eligibility, selection and `insideCellTemplate` — no platform, no app version. |
| The SDK knows them | **Yes.** `RovenueConfig` (`packages/core-rs/src/config.rs:17-22`) already has `platform: Option<String>` and `app_version: Option<String>`, supplied by the native façades. They are used for the `X-Rovenue-Platform` header and telemetry, and never reach the renderers. |
| A version-comparison helper exists | **No.** Nothing in `packages/shared`, `core-rs` or the API. |

**So the bulk of this phase is plumbing, not schema.** The facts exist; they stop at the network layer. Getting them into four renderers is the work, and it is why this phase is staged.

One consequence to design around immediately: `app_version` is `Option<String>` — a façade may not supply it, and the web renderer and the dashboard canvas have no app at all.

---

## 2. The model

```ts
export type NodeVisibility = {
  /** Platforms this node renders on. Absent or empty = all platforms. */
  platform?: Array<"ios" | "android" | "web">;
  /** Inclusive bounds on the host app's version. */
  minAppVersion?: string;
  maxAppVersion?: string;
};
```

Optional on every `PaywallNode`. Absent `visibility` means visible — which is the compatibility guarantee: every config already in the database keeps rendering exactly as it does today.

`visibility` is **not** added to `OVERRIDABLE_PROP_KEYS`. An override that changed whether a node renders would make "is this node visible" depend on a condition evaluated on the node itself; conditional *appearance* is what overrides are for, conditional *existence* is what this is.

### Evaluation

Pure, shared, one definition per platform, pinned by fixtures:

```
visible(node, ctx) =
  platformMatches(node.visibility?.platform, ctx.platform)
  && withinVersionRange(node.visibility, ctx.appVersion)
```

- **Platform absent/empty → matches.** An empty array means "no constraint", not "no platforms" — the builder produces an empty array the moment an author unticks the last box, and reading that as "never render" would make a stray click delete content from every device.
- **Unknown platform (`ctx.platform` null) → matches.** The dashboard canvas always knows its platform; a renderer that does not is a plumbing gap, and gaps must not hide content.
- **Unknown app version → matches, both bounds.** This is the important one and it is deliberate: hiding content because we cannot tell the version would silently break paywalls on any façade that has not supplied it yet, and the web renderer never will. **Fail open.**

### Version comparison

Dotted numeric, component-wise, missing components read as `0`, so `1.2` == `1.2.0` and `1.10` > `1.9`. A component that is not a run of digits makes the comparison **inconclusive**, and inconclusive fails open.

Not semver. A real semver implementation would have to be written four times (TS, Swift, Kotlin, and again for RN's JS) and agree exactly, and pre-release ordering (`1.0.0-beta` < `1.0.0`) is a rule nobody authoring a paywall bound is thinking about. Four small comparators that agree on digits and refuse to guess otherwise is the honest version. `render-fixtures.json` pins the agreement, including the refusals.

### A hidden node does not render its `fallback`

`fallback` exists for decode failures — an unknown node type on an older SDK. Hidden means the author said "not here". Rendering a fallback for a deliberately hidden node would put content on exactly the platform it was excluded from.

---

## 3. Where it is evaluated

Client-side, in all four renderers, and in the dashboard canvas.

The canvas is not an afterthought: P1 gave it a real device catalog and `vm.canvasPlatform`, so the author can see what an iPhone sees and what a Pixel sees by switching the preview device. A visibility feature the author cannot see the effect of is a feature they will not trust.

Nothing server-side changes. `/v1/placements` keeps shipping the published snapshot whole; visibility is a rendering decision, not a serving one. (Audience targeting stays at the placement level — gap analysis §8 decision 3 — and the Visibility tab links out to the placement's audience rows rather than offering a segment dropdown.)

---

## 4. Validator

One new code, warning tier: **`VISIBILITY_NEVER_MATCHES`** — a node that cannot render anywhere, because `minAppVersion` > `maxAppVersion`. Warning rather than blocking: it is dead content, not a broken config, and a publish gate that refuses it would be the fifth instance in this project of the save/publish gates rejecting a legitimate work-in-progress.

It maps to the Visibility tab's dot.

Deliberately **not** flagged: an empty `platform` array (that means "all", per §2) and a node hidden on every platform *individually* selected — the author may be mid-edit.

---

## 5. Staging

Two shippable stages. The split is along the plumbing, because that is where the risk is.

**P5b-1 — TypeScript only.** Shared schema + the pure evaluator + validator code + `render-fixtures.json` entries + the web renderer (`packages/paywall-renderer`) + the Visibility tab + the canvas honouring it via `canvasPlatform`. Ships a working feature for the dashboard preview and the web paywall, and fixes the contract the natives must then meet.

**P5b-2 — the three native renderers.** SwiftUI, Android Views, RN, each with the plumbing to get `platform` and `appVersion` from `RovenueConfig` into their render context, all four decoders agreeing with `render-fixtures.json`.

Stage 1 first because it defines the contract; stage 2 is then a conformance exercise against fixtures rather than a design exercise repeated three times.

---

## 6. Testing

- **The evaluator** — pure, so this is where the real coverage lives: platform match/miss, empty array, null platform, each bound, both bounds, equal bounds, unknown version, non-numeric component, `1.2` vs `1.2.0`, `1.10` vs `1.9`.
- **Fail-open cases get their own tests, named as such.** Every one of them is a decision that could be silently reversed by a future "tidy-up", and each should fail loudly if it is.
- **`render-fixtures.json`** — new entries covering a hidden node, a node hidden only on one platform, and an inconclusive version. These are the four-platform contract; stage 2 is judged against them.
- **The validator** — `VISIBILITY_NEVER_MATCHES` fires on min > max and not on an empty platform array.
- **The web renderer** — a hidden node renders nothing, and its children go with it.
- **The canvas** — switching preview platform changes what renders.

---

## 7. Global constraints

- TypeScript strict; Rust/Swift/Kotlin in stage 2.
- **Wire-additive only.** `visibility` is optional; an older SDK ignores an unknown key and renders the node, which is the same as absent. No migration, no DB change.
- **No magic values.** Platform strings and the issue code are structured data; any threshold gets a named constant.
- Every user-facing string via `t(key, "English fallback")`, with the key added to `apps/dashboard/src/i18n/locales/en.json` in the same commit.
- The four-platform decoder contract is `render-fixtures.json`; a change there without matching decoder work is a lie in the contract.
- Conventional commits, on the current branch (`main`).

---

## 8. Follow-ons

- P5a's deferred minors, which belong to the same surface: override-sourced localization issues dot Content while the offending key lives in Overrides; the tab strip has no `role="tablist"`/`aria-selected`/arrow-key navigation.
- Per-element font (P10), which also lands in the inspector.
