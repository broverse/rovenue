# Paywall Builder — Best-Practice Research & Gap Analysis

**Date:** 2026-07-23
**Status:** Analysis only. No implementation. Feeds a sequence of per-phase design specs.
**Design source:** Claude Design project `008cf05d-86d0-4f88-bf69-3802297259d1`, file `Rovenue Paywall Builder.html`
(+ `paywall_data.jsx`, `paywall_render.jsx`, `paywall_inspector.jsx`).

---

## 1. Why this document exists

The design mock is not an incremental restyle of the existing builder. It describes **ten
distinct subsystems**, three of which cross the four-platform renderer contract
(`packages/shared/src/paywall/render-fixtures.json` → web / SwiftUI / Android Views / RN) and
one of which requires a new on-device preview channel. Shipping it as a single plan would
either stall or land half-built.

This document establishes: what the market considers table stakes (§2), what Rovenue actually
has today (§3), the precise delta (§4), the architectural decisions that must be settled before
any code is written (§5), the complete missing-API surface (§6), and a dependency-ordered
phase plan (§7).

**Headline finding (§5.1): Rovenue has no draft/published separation for paywalls. The builder
autosaves straight into the row that `/v1/placements` serves to production devices.** Every
other item in this document is downstream of fixing that.

---

## 2. Best-practice research

### 2.1 What the three reference products do

| Capability | RevenueCat (Paywalls v3) | Adapty | Superwall |
|---|---|---|---|
| Editor model | Component-based tree, Figma-style shortcuts, copy/paste between paywalls | Visual builder, no-code | Component tree + free-form |
| Component library | Text, Image, Icon, Stack, Sticky Footer, Purchase Button, Package, Carousel, Timeline, Countdown, Social Proof, Feature List, Tabs, Video | Comparable set | Comparable set |
| Draft / publish | Auto-save for paywall drafts (shipped Jan 2026); explicit publish | Draft + publish | Local draft, explicit publish |
| Version history | Yes | Yes | Full history view, **click any entry to roll back** |
| Localization | Dedicated Localization tab; **out-of-date alerts** when the base string changes after translation | Table view across locales; AI auto-translate announced | Per-locale |
| Conditional display | **Paywall rules** — show/hide components per condition | Audience/segment targeting | Audience targeting |
| Branding | Dedicated Branding tab (saved colors + fonts) | Theme | Theme |
| Media | Media gallery | Asset manager | Asset manager |
| AI | AI Editor (chat: create sections, update layouts, wire products, inspect screenshots) | AI localization | AI Chat Builder |
| SDK compat | Server-driven UI; designs versioned against SDK | Remote config | **Designs versioned against SDK — old paywalls render on new SDKs and vice-versa** |
| Exit intent | Exit offers on paywall dismissal | — | — |

Two things stand out as *architectural*, not cosmetic:

1. **Superwall versions the design against the SDK version.** This is the mechanism that lets
   them ship new component types without waiting for app-store rollout of a new SDK. Rovenue's
   schema already has the primitive for this — see §5.2.
2. **RevenueCat's "out-of-date localization alerts"** — a translation is stale when the base-locale
   string changed after it was translated. This is strictly stronger than "missing translation",
   which is all the design mock and Rovenue's current validator model.

### 2.2 Conversion research (what the paywall content itself should encourage)

These inform which components are worth building first, and which builder-level nudges/validators
are worth adding:

- **Annual default, pre-selected, with a "Best value" badge and a monthly-equivalent price
  ("just $6.67/mo")** pushes annual selection to ~69–74%, raising 12-month LTV by 50%+ versus a
  monthly-default paywall. → the `defaultSelected` + per-month variable + badge path is the single
  highest-leverage feature. Rovenue has `defaultSelected`; the per-month/save-% variables and the
  badge slot need checking against `variables.ts`.
- **7-day (or 3-day) trials have displaced 14/30-day.** Shorter trials convert trial→paid better.
- **Visual trial timelines** ("Today: full access · Day 5: reminder · Day 7: billing starts") are an
  Apple-endorsed transparency pattern that reduces refunds. → justifies the `Timeline` component.
- **Social proof** ("Rated 4.8 by 12,400+ users") is table stakes. → justifies `SocialProof`.
- **Free-vs-Pro comparison, 4–6 features max**, checkmarks/X. → justifies a `FeatureList` component
  (present in RevenueCat, *absent from the Rovenue design mock* — worth adding).
- Six structural drivers dominate conversion: model, placement timing, plan structure, trial length,
  price level, **experiment discipline**. → the builder must make creating an experiment cheap
  (design's A/B popover), and Rovenue already has an experiment engine.

### 2.3 Implications for Rovenue specifically

- The design mock's component set is a near-exact match for RevenueCat's, minus **Feature List**
  and **Tabs**. Add `FeatureList` to the target set.
- The design mock models localization completeness but **not staleness**. Add a
  `LOCALE_STALE` validator issue (base string `updatedAt` > translation `updatedAt`).
- The design mock has no **media gallery** or **branding/theme tab**; both exist in Rovenue's
  funnel builder already (`funnel-builder/theme-tab.tsx`, `fonts.ts`) and should be mirrored
  rather than reinvented.
- The design mock's per-element font upload with an "iOS only / not embedded for Android" warning
  is more ambitious than any of the three reference products expose. Treat as late-phase (§7, P10).

---

## 3. Current state inventory

### 3.1 Data model — `packages/db/src/drizzle/schema.ts`

```
paywalls (line 732)
  id, projectId, identifier, name,
  offeringId        → offerings.id  (restrict)
  remoteConfig      jsonb  { defaultLocale, locales: { [locale]: object } }
  configFormatVersion int   default 1   (server-derived: 2 when builderConfig present)
  builderConfig     jsonb  nullable     ← THE ONLY COPY. no draft/published split.
  isActive, metadata, createdAt, updatedAt
  unique (projectId, identifier)
```

No `paywall_versions`. No `status`. No `publishedAt`.

**The mature sibling** — funnels — already models all of this:

```
funnels.status              funnelStatus enum: draft | published | archived
funnel_versions (line 2248) id, funnel_id, version_no, pages_json, theme_json,
                            settings_json, published_at, published_by
                            unique (funnel_id, version_no)
funnel_templates (line 2272) id, name, category, description, preview_image_url,
                            pages_json, theme_json, settings_json,
                            scope (system|project), project_id
```

with `POST /funnels/:id/publish`, `GET /funnels/:id/versions`, revert and duplicate already
implemented in `apps/api/src/routes/dashboard/funnels.ts` (lines 319–586), audited via
`audit()` (`action: "funnel.published"`).

**Everything the paywall builder needs for versioning already exists, proven, one directory over.**

### 3.2 Wire schema — `packages/shared/src/paywall/schema.ts`

```
BuilderConfig { formatVersion: 2, defaultLocale, localizations: Record<locale, Record<key,string>>,
                background?: ThemeColor, root: StackNode }

7 node types: stack | text | image | button | packageList | purchaseButton | spacer

Every node has:  id, overrides?: NodeOverride[], fallback?: PaywallNode
OverrideCondition = { kind: "introEligible" } | { kind: "selected" }
OVERRIDABLE_PROP_KEYS restricts which props each type may override (strict at parse time)
packageList.cellTemplate?: PaywallNode  (cell-scoped subtree)
```

### 3.3 Validator — `packages/shared/src/paywall/validate.ts`

Issue codes: `DUPLICATE_NODE_ID`, `UNKNOWN_LOC_KEY`, `FOREIGN_PACKAGE_ID`,
`MISSING_PURCHASE_BUTTON`, `CELL_TEMPLATE_BAD_NODE`, `OVERRIDE_SELECTED_OUTSIDE_CELL`,
`OVERRIDE_BAD_PROP`, `LOCALE_KEY_GAP`. A `WARNING_ISSUE_CODES` set already splits
blocking vs. non-blocking — the design's error/warning/notice tri-state is a small extension
(add an `info` tier).

### 3.4 Variables — `packages/shared/src/paywall/variables.ts`

`{{name}}` interpolation, `KNOWN_VARIABLES` derived from `PackageView` keys. Unknown variables
pass through unreplaced (safe).

### 3.5 API — `apps/api/src/routes/dashboard/paywalls.ts` (433 lines)

`GET /` · `GET /fallback-export` · `POST /` · `GET /:id` · `PATCH /:id` · `DELETE /:id`.
Guards: `requireDashboardAuth` → `assertProjectAccess` → `assertProjectCapability("products:write")`;
`MAX_BUILDER_DEPTH = 32`, `MAX_BUILDER_NODES = 500`; `purgeProjectCatalogCache` on mutation.

### 3.6 SDK-facing resolution — `apps/api/src/lib/placement-resolution.ts`

`hydratePaywall()` (line 41) reads `paywall.builderConfig` **off the live row** and ships it whole.
There is no version selection. Combined with the builder's autosave (§3.7), this means
**an in-progress edit is live on production devices as soon as the edge cache expires.**

### 3.7 Dashboard builder — `apps/dashboard/src/components/paywall-builder/`

Present: `builder-shell` (3-pane), `top-bar`, `layer-tree` (+ flatten), `canvas` (+ helpers),
`properties-panel` (914 lines), `validation-drawer`, `add-node-popover`, `presets` (hero /
comparison), `node-meta`, `tree-ops`, `vm/paywall-builder.vm.ts` (491 lines).

VM already does: color-scheme toggle, `previewEligible` toggle, canvas device
(`phone | tablet | desktop`), zoom with wheel/pinch, autosave with `AbortController` +
`beforeunload` guard + `isDirty`, locale add/remove/set-default, `setLocaleText`, overrides
CRUD, `setCellTemplate`, `applyPreset`, derived `errorIssues` / `warningIssues`.

### 3.8 Renderers

`packages/paywall-renderer` (web: `nodes.tsx`, `renderer.tsx`, `styles.ts`), sdk-swift
`RovenuePaywallView`, sdk-kotlin `paywallui`, sdk-rn `paywall-ui`. Contract:
`render-fixtures.json`.

### 3.9 Adjacent systems available for reuse

- `funnel-builder/`: `fonts.ts`, `localization-tab.tsx`, `locale-switcher.tsx`, `localized-input.tsx`,
  `theme-tab.tsx`, `rule-editor.tsx`, `preview-overlay.tsx`, `share-tab.tsx`, `thumb-rail.tsx`.
- `apps/api/src/routes/dashboard/copilot/`: `chat.ts`, `intents.ts` with
  `POST /:id/execute` / `POST /:id/reject` — a **propose-then-approve AI mutation framework
  already exists**, and is the correct backend for the design's AI FAB.
- `experiments.ts`, `audiences.ts`, `cohorts.ts`, `targeting/` — for the A/B popover and the
  Visibility tab's segment picker.
- `funnel-templates.ts` route + `funnel_templates` table — template pattern to mirror.

---

## 4. Design → repo gap matrix

Legend: **∅** absent · **◐** partial · **●** present

| # | Subsystem | Design requires | Repo today | Gap | Touches |
|---|---|---|---|---|---|
| A | **Versioning & publish** | draft v7 / published v6 / archived, history menu, name-a-version, discard draft, diff draft↔published, "Publish v7" gated on zero blocking issues | ∅ single mutable row | **Total** | DB (new table + enum), API (5 endpoints), placement-resolution, TopBar |
| B | **Node types** | 17 types: Scroll, Stack, Box, StickyFooter, Text, Image, Video, Icon, Divider, Carousel, Timeline, Countdown, SocialProof, ProductGroupSelector, ProductCard, CTAButton, FooterLinks (+ FeatureList from §2.3) | ◐ 7 types | **10–11 new types** | shared schema + validator + **4 renderers** + `render-fixtures.json` + palette + inspector |
| C | **Commerce binding** | bind to a *ProductGroup*, pick period preset (Monthly / Annual / Both), `defaultPeriod`, live "Resolved from catalog" readout (price, per-month, trial), CTA `binding.follows` the selector | ◐ `packageIds: string[]` from an Offering; no resolved readout; `purchaseButton` has no follow semantics | **Large** | shared schema, offering hydration, new resolve endpoint, 4 renderers |
| D | **Inspector 5 tabs** | Layout / Style / Content / Binding / Visibility; per-tab dot indicators; per-element font; visibility = platform ∪ min/max app version ∪ audience segment | ◐ one 914-line properties panel; no visibility model at all | **Large** | shared schema (`visibility` on every node), dashboard, 4 renderers (client-side rule eval) |
| E | **Localization matrix** | full string × locale table, per-locale completion counters, click-missing→jump-to-node, "Auto-translate gaps", base-locale marker | ◐ `LOCALE_KEY_GAP` validator + locale CRUD; no matrix UI, no auto-translate, no staleness | **Medium** | API (2 endpoints), dashboard modal |
| F | **Canvas fidelity** | real device frames (iPhone 15 Pro 393×852 / SE 375×667 / Pixel 8 412×915 / Galaxy A54 360×800) with `safeTop`/`safeBottom`/notch, status bar, "All sizes" grid, safe-area overlay, locale + light/dark switchers on the canvas bar | ◐ generic `phone/tablet/desktop`, zoom, scheme toggle | **Medium, dashboard-only** | dashboard only |
| G | **Start modal** | template gallery (5 curated + blank-last), "generate from App Store link", AI prompt with suggestion chips | ◐ `presets.ts` with 2 hard-coded presets | **Medium** | DB (`paywall_templates`), API (3 endpoints), dashboard |
| H | **On-device preview** | QR code, "Rovenue Preview" app, paired-devices list, hot reload of the draft with no app release | ∅ | **Total** | API (preview-session + SDK-facing draft endpoint + push/poll channel), SDK, a preview app |
| I | **A/B from builder** | popover offering PAYWALL-level test and **ELEMENT-level** test (single node held-out) | ◐ experiment engine exists; no builder entry point; element-level tests not modeled | **Medium–Large** (element-level is a new experiment kind) | API, shared schema, dashboard |
| J | **AI FAB** | free-text canvas command ("add a 3-step trial timeline above the plans", "audit for missing translations") | ◐ copilot chat + intent execute/reject framework exists | **Medium** — wire a paywall intent type | API (copilot intent), dashboard |
| K | **Fonts** | per-element font, uploaded `.woff2`/`.otf`, `embedded` flag, "iOS only → Android falls back to system serif" warning surfaced in both Style tab and validator | ∅ for paywalls (funnel `fonts.ts` is web-only Google Fonts) | **Total** | asset storage, API, shared schema, native SDK font registration |
| L | **Autosave / status chips** | "autosaved" ↔ "saving…" chip, publishable/blocking/warning chip in top bar | ● autosave in VM; ◐ status chips | **Small** | dashboard |

---

## 5. Architectural decisions to settle before any code

### 5.1 — DECISION REQUIRED: draft vs published (highest severity)

**Today:** `paywall-builder.vm.ts` autosaves to `PATCH /dashboard/.../paywalls/:id`, which writes
`paywalls.builderConfig`. `placement-resolution.ts:59` ships that same column to devices. The only
thing between a half-finished edit and production is the edge-cache TTL.

**This is the bug the whole design is built around solving** — the mock's "Publish v7" button,
version menu, diff modal and blocking-issues gate exist precisely because a draft must not be live.

**Recommendation:** mirror funnels exactly.

```
paywalls
  + status            paywallStatus enum (draft|published|archived), default 'draft'
  + publishedVersionId text → paywall_versions.id, nullable, on delete set null
  builderConfig       stays = THE DRAFT (autosave target, unchanged write path)

paywall_versions (new)
  id, paywall_id → paywalls.id cascade
  version_no int
  builder_config_json jsonb   -- snapshot
  remote_config_json  jsonb   -- snapshot (remoteConfig is versioned too)
  offering_id text            -- snapshot: which offering it was published against
  label text nullable         -- "name this version…"
  published_at timestamptz, published_by text → user.id set null
  unique (paywall_id, version_no)
```

`hydratePaywall()` then resolves `publishedVersionId → paywall_versions` and ships the snapshot.
A paywall with `publishedVersionId IS NULL` resolves to `null` (same as `!isActive` today) rather
than leaking a draft.

**Migration risk:** every existing paywall must get a v1 published from its current
`builderConfig`/`remoteConfig` in the same migration, or live paywalls go dark. This is the single
most dangerous step in the whole programme and must be its own reviewed migration.

**Alternative considered and rejected:** a `draftConfig` column alongside `builderConfig`
(no version table). Cheaper, but gives no history, no diff, no rollback — three explicit design
requirements — and diverges from the funnel pattern.

### 5.2 — DECISION REQUIRED: how to add 10 node types without breaking 4 renderers

Adding node types is normally a hard SDK-rollout dependency: an old SDK receiving
`type: "carousel"` cannot render it.

**Rovenue already has the escape hatch.** Every node carries `fallback?: PaywallNode`
(`schema.ts:45`, and the doc comment at :8 says exactly this: *"rendered when the primary node
can't be"*). Superwall's "designs are versioned against the SDK so old paywalls render on new SDKs
and new paywalls render on legacy ones" is the same idea.

**Recommendation:** additive expansion, `formatVersion` stays 2, with a hard rule:

1. Every renderer gains an **unknown-type branch**: render `node.fallback` if present, else render
   nothing (never crash, never blank the paywall).
2. The **builder auto-authors a fallback** for every new-type node it inserts (e.g. a `Timeline`
   gets a `stack` of `text` nodes as fallback; a `Countdown` gets a `text`). The author can edit it.
3. A validator rule `MISSING_FALLBACK_FOR_NEW_TYPE` warns (not blocks) when a
   post-v2-baseline node type has no fallback.
4. `render-fixtures.json` gains a case per new type **plus** an "old SDK sees fallback" case.

This turns a coordinated four-platform release into four independent, additive PRs, and it is
strictly better than bumping `formatVersion` to 3 (which would force every SDK to ship before any
new component is usable).

**Sequencing rule:** ship rule (1) — the unknown-type fallback branch — to all four renderers
**before** any new type reaches the wire. That is a small, standalone, high-value PR.

### 5.3 — DECISION REQUIRED: ProductGroup vs. the existing Offering/Package model

The design's `paywall_data.jsx` header states: *"flattened Product + ProductGroup (no
Offering/Package layer)"*, and commerce nodes bind `{ groupKey, periods: ['P1Y','P1M'],
defaultPeriod }` rather than package ids.

Rovenue has `products` (598), `offerings` (697) with a `packages` jsonb of slot identifiers, and
`packageList.packageIds: string[]` validated by `FOREIGN_PACKAGE_ID` against the paywall's offering.

Three options:

| | Approach | Pro | Con |
|---|---|---|---|
| **(a)** | Adopt the design literally — drop Offering/Package, introduce ProductGroup | Matches the mock; conceptually simpler | Breaking wire change across 4 SDKs + `/v1/placements` + every existing integration. Very high cost, no user-visible benefit over (c) |
| **(b)** | Add ProductGroup **alongside** Offerings | No breakage | Two overlapping catalog concepts forever. Worst of both |
| **(c)** | **Keep Offering/Package as the model; adopt the design's *ergonomics*** — the Binding tab presents the offering as a "group", derives period presets from the packages' resolved subscription periods, and stores `packageIds` + `defaultSelected` as it does today | Zero wire breakage; delivers the entire visible design (period presets, "Resolved live from catalog", "no raw ids on the CTA") | Requires a new resolve endpoint (§6.11) and a period→package mapping |

**Recommendation: (c).** The design's real content is *"the author picks periods, not ids, and the
CTA never stores a product id"* — that is an authoring-UX property, achievable without touching
the wire. Rename in the UI only.

**Corollary:** `CTAButton.binding.follows` maps onto the existing `purchaseButton`, which already
implicitly purchases the selected package. The design's "Inherit selected plan / Trial-aware label"
toggles are new, small, and additive.

### 5.4 — DECISION REQUIRED: where node-level visibility is evaluated

Design's Visibility tab: platform (`both|ios|android`), min/max app version, audience segment.

- **platform** and **app version** are known *on device* → evaluate **client-side**, ship the rule
  in the node. Costs a schema field + a per-renderer predicate. Cheap, works offline, works with
  the bundled fallback file.
- **audience segment** is already resolved **server-side** by the placement walk
  (`placement-resolution.ts` iterates ordered audience rows). Re-implementing segment evaluation
  on-device would duplicate that engine and require shipping cohort definitions to clients.

**Recommendation:** split by evaluation site.
`visibility: { platform?, minAppVersion?, maxAppVersion? }` → client-side predicate on every node.
Segment-conditioned content stays at the **placement** level (a different paywall per audience row),
which is what placements are *for*. The Visibility tab should surface a "use a placement audience
row instead" affordance rather than a segment dropdown on the node.

This is a deliberate, documented divergence from the mock, and it should be reviewed explicitly.

### 5.5 — Localization staleness (adopted from §2.1, absent from the mock)

Modelling only *missing* translations means a base-copy edit silently leaves four locales lying.
Recommend `localizations` gain per-entry `updatedAt`, and a `LOCALE_STALE` **warning** issue
(not blocking). This is additive to `Record<locale, Record<key, string>>` and needs a shape
decision: `Record<locale, Record<key, { value, updatedAt }>>` breaks the wire; a sidecar
`localizationMeta: Record<locale, Record<key, string /* ISO */>>` does not. **Recommend the sidecar.**

### 5.6 — On-device preview channel (H)

Needs: a short-lived preview token, an SDK-facing endpoint that serves the **draft** (bypassing
§5.1's published-only rule under an explicit token), a push or poll channel for hot reload, and a
host app. The "Rovenue Preview" app in the mock does not exist and is a product decision, not a
task. **Recommend descoping the app**; ship instead *deep-link into the customer's own debug build*
+ token, which the existing SDK can support with a small addition.

---

## 6. Missing API surface (complete list)

All under `/dashboard/projects/:projectId/paywalls` unless noted. Every mutation must
`audit()` inside the caller's tx and `purgeProjectCatalogCache`.

| # | Endpoint | Purpose | Phase |
|---|---|---|---|
| 6.1 | `POST /:id/publish` | Snapshot draft → new `paywall_versions` row, set `publishedVersionId`, reject if any blocking issue. Mirrors `funnels.ts:323` | P0 |
| 6.2 | `GET /:id/versions` | Version history for the menu (no, label, when, who, live flag) | P0 |
| 6.3 | `GET /:id/versions/:versionNo` | Full snapshot, for diff + rollback preview | P0 |
| 6.4 | `POST /:id/versions/:versionNo/revert` | Copy snapshot back into the draft | P0 |
| 6.5 | `PATCH /:id/versions/:versionNo` | "Name this version…" (`label` only) | P0 |
| 6.6 | `POST /:id/discard-draft` | Reset draft to `publishedVersionId`'s snapshot | P0 |
| 6.7 | `GET /:id/diff?from=&to=` | Structural diff (node/field/from/to/kind). Server-side so 4 clients don't reimplement it | P0 |
| 6.8 | `GET /:id/localizations` | Matrix payload: strings × locales + per-locale completion + staleness | P2 |
| 6.9 | `PUT /:id/localizations` | Bulk cell write from the matrix | P2 |
| 6.10 | `POST /:id/localizations/auto-translate` | Fill gaps via copilot credentials (BYOK-aware, quota-aware) | P2 |
| 6.11 | `GET /offerings/:offeringId/resolved` | Per-package resolved facts: displayName, period, periodLabel, price, currency, trialDays, perMonth, badge, store availability. **Backs both the inspector's "Resolved live from catalog" block and the canvas preview** | P1 |
| 6.12 | `GET /paywall-templates` | Curated + project-scoped gallery. Mirror `funnel-templates.ts` | P3 |
| 6.13 | `POST /paywalls/from-template` | Instantiate | P3 |
| 6.14 | `POST /paywalls/from-app-store` | Import icon/screenshots/name/description from a store listing → draft tree | P8 |
| 6.15 | `POST /:id/copilot-intent` (or a `paywall.*` intent kind on the existing `copilot/intents`) | AI FAB: propose a tree mutation, user approves via existing execute/reject | P8 |
| 6.16 | `POST /:id/preview-sessions` | Mint preview token + deep link + QR payload | P9 |
| 6.17 | `GET /v1/preview/paywalls/:token` (public, SDK) | Serve the **draft** under an explicit token | P9 |
| 6.18 | `GET /:id/preview-sessions/:sid/stream` (SSE) | Hot reload | P9 |
| 6.19 | `POST /:id/experiments` | Create a paywall-level or element-level experiment from the builder | P7 |
| 6.20 | `POST /fonts` · `GET /fonts` | Project font assets with per-platform files + `embedded` coverage flags | P10 |

Also required, not new endpoints but changed behaviour:

- **`placement-resolution.ts`** — resolve `publishedVersionId`, not the live row (P0).
- **`GET /fallback-export`** — must export the **published** version, not the draft (P0).
- **`validate.ts`** — add an `info` severity tier; add `MISSING_FALLBACK_FOR_NEW_TYPE` (P4),
  `LOCALE_STALE` (P2), `FONT_NOT_EMBEDDED_FOR_PLATFORM` (P10).

---

## 7. Phased plan

Dependency-ordered. Each phase gets its own design spec → implementation plan.

| Phase | Contents | Depends on | Touches SDK wire? | Risk |
|---|---|---|---|---|
| **P0** | **Draft/publish split.** `paywall_versions` + `status` + `publishedVersionId`; migration backfilling v1 for every existing paywall; §6.1–6.7; placement-resolution + fallback-export read published; TopBar publish button, version menu, diff modal, blocking gate | — | No (shape unchanged) | **High** (migration can dark live paywalls) |
| **P1** | **Canvas fidelity.** Real device catalog with safe areas + notches, status bar, All-sizes grid, safe-area overlay, canvas-bar locale + scheme switchers. §6.11 resolved-catalog endpoint so the preview shows real prices | P0 (nice-to-have) | No | Low |
| **P2** | **Localization matrix.** §6.8–6.10, staleness sidecar (§5.5), `LOCALE_STALE`, matrix modal, jump-to-node, auto-translate via copilot | — | Additive | Low–Med |
| **P3** | **Start modal + templates.** `paywall_templates` table mirroring `funnel_templates`, §6.12–6.13, gallery UI with blank-last | P0 | No | Low |
| **P4a** | **Unknown-type fallback branch in all four renderers** (§5.2 rule 1). Small, standalone, unblocks everything after it | — | No | Low |
| **P4b** | **Node types wave 1 (non-commerce):** stickyFooter, divider, icon, socialProof, timeline, countdown, featureList. Auto-fallback authoring, fixtures per type + per fallback | P4a | **Yes, additive** | Med |
| **P4c** | **Node types wave 2 (media):** carousel, video/lottie | P4b | Yes, additive | Med |
| **P5** | **Inspector 5 tabs + visibility.** Split the 914-line properties panel into tab modules; `visibility { platform, minAppVersion, maxAppVersion }` on every node + client-side predicate in 4 renderers; per-tab dot indicators | P4a | Yes, additive | Med |
| **P6** | **Commerce binding UX (§5.3 option c).** Period presets, defaultPeriod, resolved readout, CTA follow toggles | P1 (needs 6.11) | Minor | Med |
| **P7** | **A/B from builder.** Paywall-level (exists) + element-level experiment kind; §6.19 | P0 | Yes for element-level | Med–High |
| **P8** | **AI FAB + App Store import.** §6.14–6.15 on the existing copilot intent framework | P4b | No | Med |
| **P9** | **On-device preview.** §6.16–6.18 + SDK support; descope the standalone preview app (§5.6) | P0 | Yes (SDK) | High |
| **P10** | **Fonts.** §6.20, per-platform embedding, native font registration, `FONT_NOT_EMBEDDED_FOR_PLATFORM` | P5 | Yes | High |

**Suggested first three:** P0 → P4a → P1. P0 removes the production risk and unlocks every
publish-gated feature; P4a is a cheap insurance policy that makes all later node work additive
and independently shippable; P1 delivers the most visible chunk of the design with zero wire risk.

---

## 8. Decisions taken (2026-07-23)

All seven open questions were resolved in favour of the recommendation. Recorded here so the
per-phase specs can cite them rather than re-litigate.

1. **§5.1 — version model: ACCEPTED.** Mirror `funnel_versions` exactly: `paywall_versions` +
   `paywalls.status` + `paywalls.publishedVersionId`, draft stays in `paywalls.builderConfig`.
   The backfill migration auto-publishes a v1 for every existing paywall from its current
   `builderConfig`/`remoteConfig`/`offeringId`, in the same transaction as the DDL.
2. **§5.3 — commerce model: option (c) ACCEPTED.** Offering/Package stays on the wire.
   "ProductGroup" is adopted as **UI language only**. Period presets are derived from the
   packages' resolved subscription periods via §6.11. No SDK-breaking catalog change.
3. **§5.4 — visibility split: ACCEPTED.** `visibility { platform, minAppVersion, maxAppVersion }`
   lives on the node and is evaluated **client-side** in all four renderers. **Audience-segment
   visibility is NOT put on nodes** — it stays at the placement level, which already walks ordered
   audience rows server-side. The Visibility tab links out to placement audience rows instead of
   offering a segment dropdown. Deliberate, documented divergence from the mock.
4. **§5.6 / P9 — preview app: DESCOPED.** No standalone "Rovenue Preview" app. P9 ships a preview
   token + deep link into the customer's own debug build, plus the SSE hot-reload channel.
5. **§2.3 — `FeatureList` ADDED** to the P4b component set (free-vs-Pro comparison, 4–6 rows,
   check/X marks). Justified by conversion research; present in RevenueCat, absent from the mock.
6. **P7 — element-level A/B: DEFERRED past v1.** Paywall-level experiments (which already exist)
   are sufficient. The builder's A/B popover ships with the PAYWALL option live and the ELEMENT
   option visibly disabled with a "coming soon" affordance, rather than being omitted — the entry
   point is the valuable part. Revisit once P0–P6 are live.
7. **Auto-translate provider: reuse copilot BYOK credentials.** `routes/dashboard/copilot/`
   already has credential storage, a BYOK guard, quota accounting and prompt-injection tests. No
   new provider integration; auto-translate becomes another copilot intent kind.

### Execution order

**P0 → P4a → P1**, then re-assess. Rationale: P0 removes the live-draft production risk and
unblocks every publish-gated feature; P4a is a small standalone insurance policy that makes all
subsequent node work additive and independently shippable per platform; P1 delivers the most
visible slice of the design at zero wire risk.

---

## 9. Sources

- [RevenueCat — Creating Paywalls: Components](https://www.revenuecat.com/docs/tools/paywalls/creating-paywalls/components)
- [RevenueCat — Paywalls changelog](https://www.revenuecat.com/blog/engineering/paywalls-changelog/)
- [RevenueCat — New Paywalls editor layout (2026-01-13)](https://www.revenuecat.com/changelog/release/new-paywalls-editor-layout-2026-01-13)
- [RevenueCat — Announcing Paywall rules: show or hide paywall components](https://www.revenuecat.com/blog/engineering/announcing-paywall-rules-show-or-hide-paywall-components)
- [RevenueCat — Server-driven UI SDK on Android](https://www.revenuecat.com/blog/engineering/server-driven-android/)
- [Superwall — Paywall editor: Publishing](https://superwall.com/docs/dashboard/dashboard-creating-paywalls/paywall-editor-publishing)
- [Superwall — Paywall editor overview](https://superwall.com/docs/dashboard/dashboard-creating-paywalls/paywall-editor-overview)
- [Adapty — Paywall Builder](https://adapty.io/paywall-builder/)
- [Adapty — Paywall localization](https://adapty.io/docs/paywall-localization)
- [Adapty — Remote config](https://adapty.io/remote-config/)
- [Adapty — What does a high-performing paywall look like in 2026?](https://adapty.io/blog/high-performing-paywall-2026/)
- [Airbridge — Paywall Conversion: 6 Structural Decisions](https://www.airbridge.io/en/blog/paywall-conversion-structural-decisions)
- [Apphud — How to design a high-converting subscription app paywall](https://apphud.com/blog/design-high-converting-subscription-app-paywalls)
