# Paywall node types, wave B: `featureList`, `socialProof`, `timeline`

**Date:** 2026-07-27
**Status:** Approved, ready for planning
**Parent:** P4b in `2026-07-23-paywall-builder-gap-analysis.md`
**Depends on:** wave A (`2026-07-27-paywall-node-types-wave-a-design.md`), shipped

---

## 1. What this delivers

The second of P4b's three waves: the three node types that carry **repeated localized rows**.
Wave A deliberately introduced no new authoring primitive; this one does, and the
`LOCALIZED_KEYS` table wave A built exists precisely so these three can express "for each row,
its key" without a fourth hand-maintained list.

All three are justified by the conversion research in the gap analysis §2.2 rather than by the
design mock alone:

- **`timeline`** — a visual trial timeline ("Today: full access · Day 5: reminder · Day 7:
  billing starts") is an Apple-endorsed transparency pattern that reduces refunds.
- **`socialProof`** — "Rated 4.8 by 12,400+ users" is table stakes.
- **`featureList`** — a short feature comparison with check/X marks. Present in RevenueCat,
  absent from the Rovenue mock, added on the research's recommendation.

Three renderers, as of the React Native bridge: web, SwiftUI, Android Views.

---

## 2. Shapes

All three follow the established node shape — optional `visibility`, `overrides` and `fallback`,
a row in `OVERRIDABLE_PROP_KEYS`, and a row in `LOCALIZED_KEYS`.

```ts
type FeatureRow = {
  labelKey: string;
  /** Registry icon name. Defaults to FEATURE_ROW_DEFAULT_ICON. */
  icon?: string;
  /** false renders the row in a muted style with the excluded mark. Defaults true. */
  included?: boolean;
};

type FeatureListNode = {
  type: "featureList";
  id: string;
  rows: FeatureRow[];
  /** Applied to every row's icon that does not override it. */
  iconColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

type TimelineRow = {
  labelKey: string;
  captionKey?: string;
  /** Registry icon name. Defaults to TIMELINE_ROW_DEFAULT_ICON. */
  icon?: string;
};

type TimelineNode = {
  type: "timeline";
  id: string;
  rows: TimelineRow[];
  /** The connector drawn between steps. */
  connectorColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};

type SocialProofNode = {
  type: "socialProof";
  id: string;
  /** 0–5, rendered as filled/half/empty stars. Absent renders no stars. */
  rating?: number;
  labelKey: string;
  starColor?: ThemeColor;
  overrides?: NodeOverride[];
  fallback?: PaywallNode;
  visibility?: NodeVisibility;
};
```

### 2.1 `featureList` is one column, deliberately

The research describes a *free-versus-Pro comparison*, which is a two-column table with a header
row. This spec ships one column with a per-row mark instead.

One column covers both the common "here is what Pro gives you" list and the mixed case where
some rows are excluded, at a fraction of the cost: a two-column table needs header copy, column
width negotiation, and alignment that behaves on three platforms and at accessibility text
sizes. **The stated cost of this decision: the mock's side-by-side comparison view does not
arrive in this wave.** If it is wanted later it is a separate component, not a widening of
`FeatureRow` — widening the row after paywalls exist in the wild would be a wire change.

### 2.2 Icons come from wave A's registry

`FeatureRow.icon` and `TimelineRow.icon` hold a registry name and resolve exactly as `icon`
nodes do, including failing open on an unrecognised name. No new icon source is introduced, and
the twelve names already cover the marks these rows need — `check`, `x`, `clock`, `gift`,
`lock`, `star`.

---

## 3. The localization table earns its keep

Wave A replaced two hardcoded lists with one exhaustive table so that this wave could write:

```ts
featureList: (n) => n.rows.map((r) => r.labelKey),
timeline:    (n) => n.rows.flatMap((r) => (r.captionKey ? [r.labelKey, r.captionKey] : [r.labelKey])),
socialProof: (n) => [n.labelKey],
```

Because the table is a mapped type over the discriminant, each row's parameter is already
narrowed to its own node type — no casts. A missing row is a compile error.

This is also the first time a node contributes **more than one** key, so the two comments wave
A's review flagged as becoming stale — the one above `collectLocalizationUsages` still
enumerating "text/button/purchaseButton", and `localizedKeysOf`'s "in declaration order" — must
be corrected in the same task rather than left to drift further.

---

## 4. Defaults are declared once, in shared

Wave A's most expensive defect was leaving "what is drawn when an optional prop is absent" to
each renderer: a divider with no colour drew near-black on web, 30%-transparent on iOS and grey
on Android. Every optional prop in this wave therefore gets its default in
`packages/shared/src/paywall/schema.ts`, and all three renderers read it:

| Constant | Value | Applies to |
|---|---|---|
| `FEATURE_ROW_DEFAULT_ICON` | `"check"` | a row with no `icon` |
| `FEATURE_ROW_EXCLUDED_ICON` | `"x"` | a row with `included: false` and no `icon` |
| `FEATURE_ROW_DEFAULT_INCLUDED` | `true` | a row with no `included` |
| `TIMELINE_ROW_DEFAULT_ICON` | `"clock"` | a row with no `icon` |
| `TIMELINE_CONNECTOR_DEFAULT_COLOR` | the `DIVIDER_DEFAULT_COLOR` pair | a timeline with no `connectorColor` |
| `SOCIAL_PROOF_STAR_DEFAULT_COLOR` | `{ light: "#F59E0B", dark: "#FBBF24" }` | stars with no `starColor` |
| `SOCIAL_PROOF_MAX_RATING` | `5` | the star scale |

Icon and text colours that are absent **inherit** the ambient text colour, as wave A settled for
`icon` — a mark beside a label should take that label's colour. Inheritance is not a constant;
it is the absence of a colour instruction, and each renderer must express it that way rather
than substituting a value.

---

## 5. Authoring guidance the research justifies

The research is specific that a feature list works best at **4–6 rows**. A longer list is not a
broken config, so this is a `warning` in the established three-tier severity model — it blocks
neither save nor publish:

- `FEATURE_LIST_TOO_LONG` — emitted when `rows.length` exceeds `FEATURE_LIST_SOFT_MAX` (6).

An empty `rows` array on any of the three is also a `warning` (`EMPTY_ROWS`): it renders nothing
and is almost always an unfinished node rather than an intent.

---

## 6. Binding rules carried from wave A

These four are process requirements on the plan, not suggestions. Each is written from a defect
that actually shipped in wave A.

1. **Pair the obligations in one task.** A new node type owes entries to `OVERRIDABLE_PROP_KEYS`,
   `LOCALIZED_KEYS`, every per-type dispatcher on three platforms, *and* the inspector fields
   those override keys imply. Wave A declared override keys in one task and wrote the override
   fields in another, and shipped a labelled override control containing no inputs.
2. **No `default` branch in TypeScript per-type dispatchers.** The Swift and Kotlin compilers
   caught the missing-dispatcher-entry obligation in seconds; TypeScript did not, because the
   lookup fell through to `default: return null`. Where a dispatcher must be total, use an
   exhaustiveness check.
3. **Every optional prop's absent-value behaviour is specified in shared** — §4 above.
4. **The three renderers are reviewed together, in one review.** Every blocking finding in wave
   A, and four in the React Native bridge phase before it, came from reading the platforms
   against each other. Three task-scoped reviews are three reviews that never make that
   comparison.

---

## 7. Testing

- **Shared:** schema round-trips including a multi-row node of each type; `LOCALIZED_KEYS`
  returning every row key, mutation-checked by emptying one row function; the two new warnings,
  including that neither blocks save or publish.
- **Registry contract:** the existing per-platform coverage tests already cover the twelve icon
  names; row icons reuse them and need no new contract.
- **Per renderer:** a multi-row render of each type, an unknown row icon failing open, and an
  empty `rows` array rendering nothing rather than throwing.
- **Cross-platform:** the three renderers reviewed together against a shared checklist of what
  each type draws with every optional prop absent.
- **Not settleable by reading:** whether star half-fill, connector alignment and row spacing look
  right at accessibility text sizes. That is a device check and belongs in the next smoke session.

---

## 8. Out of scope

- Wave C (`countdown`, `stickyFooter`).
- A two-column comparison table — see §2.1.
- Per-row visibility. Rows are content, not nodes; a row that should disappear on one platform
  belongs in a separate `featureList` with node-level `visibility`.
