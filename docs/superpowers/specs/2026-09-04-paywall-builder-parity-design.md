# Paywall Builder Parity — Design (ROADMAP §3)

**Date:** 2026-09-04
**Area:** ROADMAP §3 — Paywall builder & native rendering (85 → 95)
**Scope:** the four §3 lines that are open on paper:

1. Element-level experiments (deferred from P7)
2. New node types at RC Paywalls v2 parity — footer link group
3. Template gallery: 15–20 proven paywall templates
4. Localization workflow: in-builder translation management + auto-translate (Rovi)

Out of scope, and staying open: **on-device smoke test session** — it needs
physical iOS/Android hardware and store sandbox accounts, so no change in this
repo can close it.

---

## 0. What recon changed about the scope

Each of the four lines was re-checked against the code before it was designed.
Two of them turned out to be substantially different from their wording:

**Item 1 is already shipped.** The 2026-09-01 experiments-decision-engine work
(§4, closed 2026-09-02) delivered element-level experiments end to end:
`ELEMENT` is a live experiment type (`packages/db/src/drizzle/enums.ts:103`),
variants carry `{ paywallId, nodeId, props }`
(`packages/shared/src/experiments/types.ts:163`), save-time validation rejects
an unknown node or a non-overridable prop
(`apps/api/src/services/experiment-create.ts:162`), and `resolvePlacement`
materializes each variant server-side into the placement envelope's existing
per-variant paywall slot (`materializeElementVariants`,
`apps/api/src/lib/placement-resolution.ts:305`) so no renderer, fixture or SDK
had to change. The builder can launch one from the canvas
(`apps/dashboard/src/components/paywall-builder/experiment-popover.tsx`).

The §3 checkbox is a stale duplicate that nobody re-visited when §4 closed on
the same day. It gets ticked with a pointer to §4 — **not** re-implemented.

One genuine loose end survives inside that feature and is in scope here: the
element-experiment popover lists `border` among the overridable props but has
no editor that can produce a `NodeBorder`, so picking it leaves Create
permanently disabled. It fails safe, but it is a dead end in the UI, so this
plan adds the missing editor rather than leaving a prop that can be chosen and
never used.

**Item 2 is one node type, not four.** `carousel`, `timeline` and `video`
already exist in the schema, in all three renderers and in
`render-fixtures.json`. Only a footer link group is absent — see §2.

Items 3 and 4 are genuinely open and are the bulk of the work.

---

## 1. Element experiments: close the `border` dead end

**Problem.** `OVERRIDABLE_PROP_KEYS` includes `border` for the node types that
carry one. The experiment popover derives its prop picker from that table, so
`border` is offered. Its value type is `NodeBorder` (a width/colour/radius
object), and the popover only has string/number/colour editors, so the variant
value can never be made valid and the Create button stays disabled.

**Fix.** Add a `NodeBorder` editor to the popover's per-prop editor switch,
built from the same primitives the inspector's border control already uses.
The editor switch is derived from the prop's schema type, so the rule stays:
**a prop that is offered must have an editor**.

**Guard.** A test that walks every prop key in `OVERRIDABLE_PROP_KEYS`, asks
the popover's editor resolver for an editor, and fails by name on any prop
that resolves to none. This is the same "fails by name" shape as the
`trialLabelKey` mapped type from 2026-09-01: adding an overridable prop with
no editor breaks a test that names the prop, instead of silently shipping a
disabled button.

---

## 2. Footer link group node

**What it is.** The row of small, low-emphasis legal/action links every
shipping paywall has at the bottom: *Restore Purchases · Terms · Privacy*.
It becomes the **18th** node type; the union has 17 today
(`packages/shared/src/paywall/schema.ts:424`).

**Why a node type rather than a stack of buttons.** Today an author can
approximate it with a horizontal stack of `plain` buttons, which is what the
`hero` preset does with a single Restore button
(`apps/dashboard/src/components/paywall-builder/presets.ts:35`) — a `text`
node cannot be tapped at all, it has no `action` field, so every link must be
a button. That approximation gets three things wrong that a first-class node
gets right:

- **Separators.** The dot/pipe separator between links is not expressible; an
  author has to fake it with text nodes between buttons, which then need their
  own localization keys and break when a link is hidden.
- **Wrapping.** Three links plus separators overflow on a 320pt-wide device.
  A stack either clips or forces a fixed axis; the footer node wraps as a unit
  and keeps the separators correct across the wrap.
- **Uniform type treatment.** Footer links share one type scale, colour and
  hit-target size by definition. Expressing that as N independent buttons
  means N chances to get it inconsistent, and RC's own v2 footer is a single
  component for exactly this reason.

**Schema** (`packages/shared/src/paywall/schema.ts`), a new member of the node
union:

```ts
{
  type: "footerLinks";
  id: string;
  links: FooterLink[];      // 1..MAX_FOOTER_LINKS
  separator?: "dot" | "pipe" | "none";   // default "dot"
  align?: "start" | "center" | "end";    // default "center"
  // plus the style props every node carries
}

type FooterLink = {
  labelKey: string;                       // localized, like every other label
  action: ButtonAction;                   // reuses the EXISTING action union:
                                          // { kind: "restore" } | { kind: "url", url }
                                          // | { kind: "close" }
};
```

It reuses `ButtonAction` verbatim rather than inventing a footer-specific
action union — a footer link and a button link do the same three things, and a
second union would be a second thing to keep in sync across three renderers.

**Localization.** `LOCALIZED_KEYS.footerLinks` returns every link's
`labelKey`. That table is a mapped type over the node discriminant
(`packages/shared/src/paywall/validate.ts:63`), so the new node type does not
compile until this is decided — which is the guard, not an afterthought.

**Three-platform contract.** `render-fixtures.json` gains footer-link cases
(each separator style, the wrap case, a single-link case), and the web, SwiftUI
and Android decoders each implement the node. Per the 2026-07-29 lesson,
**fixtures are edited last**, after all three renderers can decode the shape,
so a fixture never describes something no renderer draws yet.

**Node-level consistency.** The node supports what every other node supports:
conditional overrides (`introEligible`/`selected`) on its style props,
`OVERRIDABLE_PROP_KEYS` entries for the props that are safe to vary (never
`links`, never `action` — same rule that keeps `packageIds` and `action`
non-overridable today), an optional `fallback` subtree like every other node,
and the style props of its closest sibling types. `cellTemplate` is **not** a
universal node feature — it exists only on `packageList` — so the footer node
does not get one.

**The guards this must satisfy.** Adding a node type is safe here precisely
because six checks fail by name when a step is skipped:

1. `OVERRIDABLE_PROP_KEYS` — `as const satisfies Record<PaywallNode["type"],
   readonly string[]>` (`schema.ts:481`); a missing row fails to compile.
2. `LOCALIZED_KEYS` — a mapped type over the discriminant
   (`validate.ts:58`); a missing row fails to compile.
3. `collect-urls.ts` — `const exhaustive: never = node` (`collect-urls.ts:98`);
   every node needs a case even when it carries no URL.
4. `tree-ops.ts` `newNode()` — `const exhaustive: never = type`
   (`tree-ops.ts:463`), the new-node factory.
5. `overrides.tsx` `OverridablePropCombo` — `const exhaustive: never = combo`
   (`overrides.tsx:356`); an overridable prop with no editor fails to compile.
6. `render-fixtures.test.ts` node-type coverage — derives the expected set
   from `OVERRIDABLE_PROP_KEYS`'s own keys and fails with the missing type
   **named** (`render-fixtures.test.ts:202`).

**One weak spot gets fixed on the way.** The inspector's `content-tab.tsx:58`
and `style-tab.tsx:36` switches end in `default: return null` rather than a
`never` guard, so a node type with no editor renders an empty inspector
silently instead of failing the build. Both switches become exhaustive as part
of this work — it is the same class of bug the `overrides.tsx` union already
fixed in September, in the two files immediately next to it.

`paywallNodeSchema` is a `z.union`, not a `z.discriminatedUnion`, because
`countdownNodeSchema` carries a `.refine()` (`schema.ts:815`). The footer node
is added to that union with no refinement, so nothing about that changes.

**Files touched** (derived from how `timeline`/`carousel` were added):
shared `schema.ts`, `validate.ts`, `collect-urls.ts`, `render-fixtures.json`,
plus their tests; web `nodes.tsx` + `styles.ts`; Swift
`BuilderConfigModel.swift` (props struct, enum case, decoder branch, `id` and
`visibility` accessors) + `RovenuePaywallView.swift` (view + dispatch) +
`BuilderConfigModelTests.swift` (fixture lookups **by name**, never by index);
Kotlin `BuilderConfigModel.kt` (sealed-class member + decoder branch) +
`NodeViewFactory.kt` + its tests; dashboard `node-meta.ts`, `tree-ops.ts`,
`inspector/content-tab.tsx`, `inspector/style-tab.tsx`,
`inspector/overrides.tsx`; and `i18n/locales/en.json` for the palette label and
every authorable field label.

---

## 3. Template gallery

**Where it goes.** The gallery already exists in skeleton form: `StartModal`
(`apps/dashboard/src/components/paywall-builder/start-modal.tsx`) has
`presets` / `appstore` / `ai` tabs and auto-opens on a blank paywall. It
currently offers **two** presets, `hero` and `comparison`
(`presets.ts:104`). The item is "15–20 proven templates", so the work is to
grow that catalogue and make a catalogue of that size navigable — not to
build a new surface.

**Templates stay code, not database rows.** A template is a pure function
`(defaultLocale) => BuilderConfig`. No table, no migration, no seeding, no
per-project copy. This follows the existing preset contract and it is the only
option that survives the two hard constraints below.

**Constraint A — no template may carry an asset URL.** Asset-CDN URLs are
`{projectId}/{assetId}.{ext}` by construction (`apps/api/src/lib/asset-store.ts:34`).
A template that shipped a real image would point every project at one
project's private prefix. Templates therefore ship image nodes with an empty
URL (`url: { light: "" }`) — exactly what the `hero` preset already does — and
the builder surfaces them as "replace this image" placeholders. An empty URL
passes the save tier and is caught by the publish gate, so a template can be
applied and edited freely but cannot be published with a hole in it.

**Constraint B — no template may bind to project data.** No `packageIds`, no
`defaultSelected`, no offering identifiers. `packageIds: []` already means
"every package in the offering", and `FOREIGN_PACKAGE_ID`
(`packages/shared/src/paywall/validate.ts:716`) mechanically rejects anything
else, so this constraint is enforced by the validator rather than by
discipline — the catalogue test below runs every template through it.

**Avoiding 18 bespoke tree builders.** Hand-writing 18 full node trees would
be ~2000 lines of near-duplicate object literals. Instead the catalogue is
built from a small kit of section factories — hero, feature list, comparison
table, timeline, carousel, video hero, social proof, countdown, package list
variants, footer links — each returning a subtree with a stable id prefix and
its own localization entries. A template is then a short composition plus its
copy. The kit also guarantees every template exercises real node types
(including the new `footerLinks`) rather than degenerating into text-and-button
layouts.

**Catalogue shape.** Each entry carries `{ id, name, category, tags,
build(defaultLocale) }`. Categories are the axis a 15–20 item grid needs to
stay navigable: *Minimal · Feature-led · Comparison · Trial-led · Discount /
Urgency · Media-led*. Categories and tags are a structured data table, which
is the point of the table — not magic values.

**Previews.** The current card preview is an abstract silhouette derived from
the tree (`start-model.ts`). With 18 templates a silhouette stops being
informative — four minimal templates produce four near-identical silhouettes.
The cards render the real tree through `PaywallRenderer` at a small scale,
using the synthetic offering + `placeholderPriceView` path the builder canvas
already uses for exactly this "no real price feed" situation
(`apps/dashboard/src/components/paywall-builder/canvas-helpers.ts:39`). No new
rendering mode is needed — `PaywallRenderer` is an ordinary React component
and the canvas already proves it scales via CSS transform.

**The catalogue test** (one test, every template): for each entry, `build("en")`
parses against `builderConfigSchema`, passes `validateBuilderConfig` with no
issues outside `LOCALE_KEY_GAP`, references zero package ids, sets no
`defaultSelected`, carries no non-empty asset URL, and has a localization entry
for **every** key its own tree declares. That last clause is the one that
actually bites: a template whose copy misses a key it references renders blank
and would otherwise ship silently.

---

## 4. Localization workflow + auto-translate

**What exists.** Paywall content localization is already key-based and
self-contained: every text-bearing node carries a key, and
`BuilderConfig.localizations[locale][key]` holds the string
(`packages/shared/src/paywall/schema.ts:483`). `resolveText` falls back
locale → `defaultLocale` → null, and that rule is ported identically into the
web, SwiftUI and Android renderers. The builder has a String × Locale matrix
modal with per-locale completion badges and a publish gate on gaps.

**What is missing**, precisely: (a) adding a locale is a free-text box — the
author types `pt-br` or `PT_BR` and gets whatever they typed
(`vm.addLocale`, `paywall-builder.vm.ts:650`); (b) every cell is typed by hand;
(c) there is no way to see, per locale, what is left to do beyond a count.

### 4.1 Locale picker instead of free text

`addLocale` keeps normalizing, but the UI becomes a searchable picker over a
named list of store-supported locales, with `Intl.DisplayNames` supplying the
English and native names — the same approach the funnel builder's locale
switcher already uses (`funnel-builder/locale-switcher.tsx:19`), so the two
builders name languages the same way. The candidate list is a structured
constant in `@rovenue/shared/i18n` with a comment naming its source (the App
Store / Play Console storefront locale sets), and free entry survives as an
escape hatch for a code the list does not carry.

### 4.2 Auto-translate (Rovi)

**Endpoint.** `POST /dashboard/projects/:projectId/paywalls/:id/translate`,
body `{ sourceLocale, targetLocale, entries: Record<key, string> }`, response
`{ data: { entries: Record<key, string> } }`.

**The strings come from the request, not from the database.** This is forced
by the client-side-apply invariant: the builder autosaves on its own schedule,
so the row the server can read is stale by design, and a server-side
`builderConfig` write would be clobbered by the next autosave tick. Both
existing AI paywall paths return a config or an op and let the client apply it
(`paywalls.ts:404`, `paywalls.ts:563`); translate follows the same shape and
returns entries the VM merges through the **existing** `setLocalizations`
tree-op (`packages/shared/src/paywall/tree-op.ts:21`), which merges rather than
replaces, so a hand-written translation is never silently overwritten.

**Model call.** `generateObject` from the Vercel AI SDK against the project's
BYOK provider (`resolveProviderForProject`), matching
`apps/api/src/services/paywall-ai/generate.ts`. The schema is a flat
`Record<key, string>` for one target locale — one locale per call, so quota
accounting and partial failure both stay simple, and the client loops with
per-locale progress.

**Placeholder preservation is the correctness invariant.** Paywall strings
carry `{{price}}`, `{{period}}`, `{{packageName}}` and friends
(`packages/shared/src/paywall/variables.ts`), and an unresolvable placeholder
renders **verbatim** to the end user rather than throwing — so a model that
translates `{{price}}` into `{{fiyat}}` produces a paywall that displays
literal braces to a paying customer, and nothing downstream catches it. After
generation, every returned string is checked to carry exactly the same
multiset of `{{token}}` occurrences as its source. A mismatch retries once
with the offending keys named in the prompt (the retry-once shape
`generate.ts:39` already uses); a second failure drops those keys from the
response and reports them, rather than returning a corrupted string.

Two further checks: a key that is absent from the response is reported, not
silently skipped, and a response key that was not asked for is dropped.

**Quota.** The route composes `roviQuotaGuard()` **and** calls
`bumpUsage` with the real input/output token counts after the model returns.
Neither implies the other — the guard reads, `bumpUsage` writes — and a Rovi
endpoint that guards without feeding lets a project translate forever for
free.

**Content safety.** Reuses the same pseudonymize/sterilize posture as the
existing copilot path for anything sent to a third-party provider.

### 4.3 Translation management in the builder

The matrix modal gains what a translator actually needs:

- **Translate this locale** per column: fills only the empty cells by default,
  with an explicit "retranslate everything" as a separate, confirmed action.
  Merge-not-replace is the default because the alternative silently destroys
  hand-corrected copy.
- **Per-cell translate** for one string, from the cell itself.
- **Progress and revert**: translation is applied through the VM's existing
  AI-apply snapshot (`configBeforeAiApply` / `revertAiChange`,
  `paywall-builder.vm.ts:753`), so one undo restores the pre-translation state
  and any manual edit clears the snapshot — the behaviour the other AI paths
  already have.
- **Machine-translated marking.** A cell filled by the model is marked as such
  in builder-local state so a reviewer can see what has not been read by a
  human. This lives in the builder's own UI state, **not** in `BuilderConfig`
  — the config is the three-platform decoder contract, and adding an
  authorship field to it would push a dashboard concern into the SDK wire
  format and into `render-fixtures.json`.

### 4.4 Region-aware locale matching

`resolveText` matches the requested locale **exactly**, then falls straight to
`defaultLocale` (`packages/shared/src/paywall/validate.ts:843`). A host app that
passes the device locale `pt-BR` against a paywall whose table is keyed `pt`
therefore shows English, silently — the renderer has no way to report a miss,
it just returns the fallback string.

Today this mostly works by accident: authors type one code and hosts happen to
pass it back. A curated locale picker makes the mismatch systematic, because
the store locale lists are full of region-tagged codes (`pt-BR`, `zh-Hans`,
`en-GB`) while an author translating "Portuguese" may well key it `pt`. Adding
translations without fixing the lookup would ship a feature that produces
tables the SDK cannot always find.

So `resolveText` gains one step: **requested → base language → defaultLocale**,
using the same progressive-truncation rule `@rovenue/shared/i18n`'s `expand()`
already implements for the funnel/remote-config side
(`packages/shared/src/i18n/pick.ts:26`). Matching is case-insensitive on the
locale key, since BCP-47 tags are, and the builder lowercases what an author
types (`vm.addLocale`, `paywall-builder.vm.ts:651`) while a device reports
`pt-BR`.

The change is strictly widening — an exact match still wins, so no paywall
that resolves correctly today resolves differently — and it must be ported to
all three renderers with fixture cases, because `resolveText` is part of the
decoder contract, not a web-only helper.

### 4.5 Known gap, deliberately not closed

`ImageNode.alt` is the one user-facing string that is a raw value rather than
a key (`LOCALIZED_KEYS.image` returns `[]`). Localizing it means adding
`altKey` to the schema, which is a three-renderer + fixtures change on the same
scale as a new node type. It is recorded in the ROADMAP as its own line rather
than folded into this work.

---

## 5. Architecture summary

| Area | Where the work lands | Migration? | Renderer change? |
|---|---|---|---|
| Element experiments | dashboard popover only | no | no |
| Footer link group | shared schema + 3 renderers + fixtures | no | **yes, all three** |
| Template gallery | dashboard only (`presets.ts` → catalogue + kit) | no | no |
| Auto-translate | api route + service, dashboard modal, shared locale list | no | no |
| Locale matching | shared `resolveText` + its 3 ports + fixtures | no | **yes, all three** |

**No database migration anywhere in this plan.** Templates are code, locale
choices already live inside `BuilderConfig`, and translation returns a patch
the client applies. This matters right now: migration `0115` and
`packages/db/src/drizzle/schema.ts` are held by in-flight §2 work in the
working tree, and this plan must not touch either.

## 6. Testing strategy

- **Shared schema:** the footer node's Zod parse, `LOCALIZED_KEYS` coverage,
  and the exhaustive-switch guards that fail by name on a missing case.
- **Three-platform contract:** `render-fixtures.json` footer cases decoded by
  the web renderer (Vitest), SwiftUI (`swift test`) and Android
  (`testDebugUnitTest` — `compileReleaseKotlin` does not run tests). There is
  no fourth decoder to satisfy: `packages/core-rs` carries zero references to
  any node type — it caches and serves the builder config as an opaque blob —
  and React Native hosts the native views rather than rendering its own.
- **Catalogue:** one test over every template entry (§3), so adding a
  nineteenth template cannot skip validation.
- **Auto-translate:** placeholder preservation, merge-not-replace, missing-key
  reporting and quota feeding are tested against a **stubbed model client**
  that returns deliberately corrupted output — the point is to prove the guard
  rejects it. No test asserts that a real model translates correctly; that
  would be self-confirming and would test the vendor, not this code.
- **Quota feeding** is asserted against a real row read after the call, not
  against a mock's call log.
