# Paywall node types, wave A: `divider`, `icon`, and an extensible localization collector

**Date:** 2026-07-27
**Status:** Approved, ready for planning
**Parent:** P4b in `2026-07-23-paywall-builder-gap-analysis.md`
**Depends on:** the RN native paywall bridge (`2026-07-25-rn-native-paywall-bridge-design.md`), shipped

---

## 1. What this delivers

The first of P4b's three waves. Two new node types — `divider` and `icon` — plus the
localization-key refactor that waves B and C need. Split this way because each wave introduces
one new capability: A adds no new authoring primitive, B adds repeated localized rows, C adds
runtime behaviour and layout.

**Three renderers, not four.** The React Native bridge landed, so `sdk-rn` hosts the Swift and
Kotlin views rather than rendering a tree of its own. Every node type in P4b is now implemented
in `packages/paywall-renderer` (web), `sdk-swift` and `sdk-kotlin`.

---

## 2. Icons

### 2.1 Each platform draws with its own native set

| | Source | Mechanism | Cost |
|---|---|---|---|
| **Web** | `lucide-react` | React component per icon | `packages/paywall-renderer` gains its first runtime dependency |
| **Android** | Material Icons | VectorDrawable XML vendored into the AAR | `sdk-kotlin` gains its first `res/` tree |
| **iOS** | SF Symbols | `Image(systemName:)` | none — no assets, no parser |

This is a deliberate change from the earlier P4b sketch, which had one geometry source (lucide
path data) rendered everywhere. Two things settled it. The bridge removed React Native from the
renderer set, which was the platform that made a shared path pipeline awkward. And a check of
the twelve candidate icons found that **eight of them use SVG arc commands** — so any
"one path source, parsed on each platform" design needs either arc-to-cubic flattening in a
generator or an arc-capable parser per platform, while all three native mechanisms handle arcs
for free.

**Accepted consequence, stated plainly: the same paywall now looks different on all three
platforms.** Lucide is stroked at 2px; Material Icons are filled; SF Symbols are Apple's. A
checkmark in a feature list will be visibly different on web, Android and iOS. That is the
direct consequence of choosing each platform's native set, and it is the same trade RevenueCat
and Adapty accept by rendering natively at all.

### 2.2 The registry

`packages/shared/src/paywall/icon-registry.json` — a name mapping table, not geometry. Twelve
semantic names, each with its per-platform identifier. Every row below was verified: the
Material drawable returns HTTP 200 from the official repository, the lucide export exists in
the installed package's type surface, and the SF Symbol is an iOS 13/14-era name chosen to sit
safely under this SDK's iOS 15 floor.

| Semantic name | Web (lucide-react) | Android (Material) | iOS (SF Symbol) |
|---|---|---|---|
| `check` | `Check` | `action/done` | `checkmark` |
| `x` | `X` | `navigation/close` | `xmark` |
| `star` | `Star` | `toggle/star` | `star.fill` |
| `lock` | `Lock` | `action/lock` | `lock.fill` |
| `shield` | `Shield` | `action/verified_user` | `checkmark.shield.fill` |
| `sparkle` | `Sparkles` | `image/auto_awesome` | `sparkles` |
| `bolt` | `Zap` | `image/flash_on` | `bolt.fill` |
| `gift` | `Gift` | `action/card_giftcard` | `gift.fill` |
| `clock` | `Clock` | `action/schedule` | `clock.fill` |
| `infinity` | `Infinity` | `places/all_inclusive` | `infinity` |
| `cloud` | `Cloud` | `file/cloud` | `cloud.fill` |
| `arrow-right` | `ArrowRight` | `navigation/arrow_forward` | `arrow.right` |

The Android column names a category and icon in `google/material-design-icons`; the vendored
file is fetched from
`android/<category>/<name>/materialicons/black/res/drawable/baseline_<name>_24.xml`
(Apache-2.0, attribution recorded in the registry's `_comment`). The fetched XML carries
`android:tint="?attr/colorControlNormal"`, which must be stripped — the node supplies its own
colour.

The twelve were chosen for paywall use: feature included/excluded, rating, gating, guarantee,
premium, speed, trial offer, urgency, unlimited, sync, and a CTA affordance.

### 2.3 Divergence guard

Each platform carries a test asserting its own table covers every name in the registry. A name
that renders on web and leaves a hole on Android becomes a red test on Android rather than a
silent gap. This mirrors how `render-fixtures.json` and `bucketing-vectors.json` already work
in this repo.

---

## 3. Schema

Both node types follow the existing shape: optional `visibility`, `overrides` and `fallback`,
and an entry in `OVERRIDABLE_PROP_KEYS` (a `Record` keyed by node type, so the compiler
requires it).

```ts
type DividerNode = {
  type: "divider";
  id: string;
  color?: ThemeColor;
  thickness?: number;   // default DIVIDER_DEFAULT_THICKNESS
  inset?: number;       // horizontal inset, default 0
};

type IconNode = {
  type: "icon";
  id: string;
  name: string;         // registry name; unknown → renders nothing, fails open
  size?: number;        // default ICON_DEFAULT_SIZE
  color?: ThemeColor;   // tint
};
```

`name` is a free string, **not a closed enum**. A closed enum would make adding a thirteenth
icon a wire change that older SDKs reject wholesale, which contradicts the lenient-decode and
fallback posture the rest of this system takes. Unknown names fail open at render time; the
validator raises a `UNKNOWN_ICON_NAME` warning at authoring time so the author is not left
guessing. Per the established severity model that code is a `warning` — it blocks neither save
nor publish, because an unrecognised name is a typo to surface, not a broken config.

**Auto-fallback.** The builder authors a `spacer` of matching footprint as each new node's
`fallback`, so an older client that does not know the type leaves the layout intact rather
than collapsing it. The author can edit it.

---

## 4. The localization collector refactor

Today the set of localization keys a node contributes is hardcoded in two places —
`validate.ts:231-234` and again at `331-332` — and covers only `text.key` and
`button`/`purchaseButton`'s `labelKey`. Wave B's `featureList`, `socialProof` and `timeline`
each carry an array of localized rows, which a flat list of property names cannot express.

Replace both sites with one table:

```ts
const LOCALIZED_KEYS: Record<PaywallNode["type"], (node: PaywallNode) => string[]>
```

Same shape as `OVERRIDABLE_PROP_KEYS` in the same file, exhaustive by construction, and able to
express "for each row, its `labelKey`" when wave B needs it. Neither new type in this wave
contributes a key — `divider` and `icon` map to `() => []` — so the refactor lands here with
its behaviour pinned by the existing suite, and wave B only adds rows to the table.

This is why the refactor belongs to wave A rather than wave B: doing it alongside three new
row-carrying types would mix a structural change with new features in one review.

---

## 5. Testing

- **Shared:** schema round-trips for both types, `OVERRIDABLE_PROP_KEYS` exhaustiveness, the
  `UNKNOWN_ICON_NAME` warning, and the collector refactor pinned by the existing localization
  tests, which must not change count.
- **Registry contract:** one test per platform asserting full coverage of the registry names.
- **Web:** rendering tests for both node types, including an unknown icon name rendering
  nothing rather than throwing.
- **Swift / Kotlin:** decode + render tests in the pattern established by the visibility work,
  driven off the shared registry rather than hand-written lists.
- **Not settleable by reading:** whether each SF Symbol and Material drawable actually renders
  at the expected weight and colour. That is a device check, and it belongs in the next smoke
  session rather than being claimed here.

---

## 6. Out of scope

- Waves B (`featureList`, `socialProof`, `timeline`) and C (`countdown`, `stickyFooter`).
- Any icon beyond the twelve. Adding a thirteenth is a registry row plus three mappings, by
  design.
- An icon picker beyond a simple grid in the inspector's Content tab.
