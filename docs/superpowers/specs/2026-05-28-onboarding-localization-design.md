# Onboarding Localization — Design

**Date:** 2026-05-28
**Author:** vfurkanguner
**Status:** Draft

## Goal

Give a customer-built onboarding funnel a way to ship in multiple end-user languages — both the strings the customer types in the funnel-builder (titles, options, benefits, CTAs, …) and the system strings the runner emits (Continue / Back / "This field is required"). Ship a shared `@rovenue/shared/i18n` module so the upcoming paywall builder reuses the exact same types, resolver, and authoring primitives.

The system must be small enough to land in a single PR but flexible enough that the paywall builder plugs in without revisiting the storage shape.

## Non-Goals

- **Dashboard chrome localization.** The admin UI already uses `i18next` (`apps/dashboard/src/i18n/`). That layer is untouched.
- **Auto-translation / machine translation.** A customer might integrate an LLM later; v1 is human-authored only.
- **Vendor translation export (POEditor / Crowdin / Lokalise).** `Localized<T>` *is* the export format — a dump-to-JSON helper can be bolted on later when a customer asks.
- **Locale-aware number / date / currency formatting** beyond what `Intl.NumberFormat` / `Intl.DateTimeFormat` already give us at the call site. No central formatter abstraction in v1.
- **RTL / bidi mirroring** of layouts. Flagged as a paywall-builder follow-up.
- **Per-project locale catalogue.** Locales are a per-funnel property; nothing is hoisted to project-level in v1.
- **Backend schema migration.** Funnel configs are stored as JSONB; `Localized<T>` is just a different shape inside the same column. No SQL migration required.

## Decisions

| Concern | Choice | Reason |
|---|---|---|
| Storage shape | **Inline `Localized<T> = Record<LocaleCode, T>`** per translatable field | Pages stay self-contained, easy to clone / version / diff; no separate string-catalogue to keep in sync; paywall builder reuses the same `<LocalizedInput>` |
| Locale code format | **BCP47** strings (`"en"`, `"tr"`, `"pt-BR"`) treated as opaque | Matches `navigator.language`, Accept-Language, and what Intl APIs expect — no custom enum to police |
| Region fallback | Resolver does longest-prefix walk (`pt-BR → pt → fallbacks → default`) | Customers will commonly author one variant per language (e.g. `pt`) but visitors land with regional codes (`pt-BR`); same goes for `en-US → en` |
| Default locale | Lives on the `Funnel` (`defaultLocale: LocaleCode`); also gates the resolver's terminal fallback | Each funnel knows its own canonical language; shared `LocaleSet` makes paywall reuse trivial |
| Empty-string handling | Resolver treats `""` and `[]` as missing → falls through to the next locale | The builder leaves fields blank for unfilled translations; we never want to render `""` |
| Back-compat with existing data | Resolver accepts bare `T` and returns it as-is; `normalizeFunnel` lifts bare strings into `{ [defaultLocale]: value }` on first save | Existing funnels (saved before this feature) keep rendering with no migration job; the lift is opportunistic |
| System strings | Plain JSON packs under `apps/dashboard/src/runner/locales/<lng>.json`, resolved through the same `pick()` | One mental model for system + content; no separate i18next instance inside the runner |
| Runtime locale source | **URL `?lng=` → `navigator.language` → `funnel.defaultLocale`**, allowlisted by `funnel.locales` | URL beats browser so customers can A/B share links; allowlist keeps a stray `?lng=zz` from breaking the runner |
| Builder authoring UX | Header **locale switcher** + a `<LocalizedInput>` wrapper bound to `value[editLocale]` | One component swap; properties-panel field code barely changes |
| Missing-translation surfacing | Validation drawer adds one warning row per `(locale, page, field)` that is empty in a non-default locale | Customer sees what's left to translate without leaving the builder |
| What "translatable" means for `options` | `Option.value` stays a stable opaque id; only `Option.label` becomes `Localized<string>` | Branching rules already compare on `value` — must not move with translation |
| `mediaUrl`, `imageUrl`, `productId` etc. | **Not** translatable in v1 | YAGNI; per-locale media is a separate, larger design |

## Architecture

### Package layout — `@rovenue/shared/i18n`

```
packages/shared/src/i18n/
  types.ts          // Localized<T>, LocaleCode, LocaleSet
  pick.ts           // pick(), expand(), isLocalized()
  normalize.ts      // liftToLocalized(), mapLocalizedFields()
  index.ts          // barrel
  pick.test.ts
  normalize.test.ts
```

`@rovenue/shared/i18n` declares only generic primitives — it must not import from `apps/dashboard`. Funnel-specific wrappers (`normalizeFunnel`, `mapFunnelLocales`) live next to the funnel types in `apps/dashboard/src/components/funnel-builder/i18n.ts` and call into the generic walker.

Re-exported from `@rovenue/shared` so consumers do `import { pick, type Localized } from "@rovenue/shared/i18n"`. Builder, runner, and the future paywall builder all import from this single module.

### Core types

```ts
// packages/shared/src/i18n/types.ts

/** BCP47 language tag, e.g. "en", "tr", "pt-BR". Treated as opaque by the resolver. */
export type LocaleCode = string;

/** A value that varies by locale. Missing keys fall through to the resolver chain. */
export type Localized<T> = { readonly [locale: LocaleCode]: T };

/** Per-funnel locale configuration. Also used by the paywall builder. */
export type LocaleSet = {
  /** Canonical authoring language; resolver's terminal fallback. */
  default: LocaleCode;
  /** All locales the funnel/paywall is allowed to render in. */
  available: readonly LocaleCode[];
};
```

### Resolver

```ts
// packages/shared/src/i18n/pick.ts
import type { Localized, LocaleCode } from "./types";

/**
 * Resolve a possibly-localized value for the requested locale.
 *
 * Accepts a bare T (treated as already-resolved) so existing data without
 * Localized<T> wrappers still works. Empty strings and empty arrays are
 * treated as missing and fall through.
 */
export function pick<T>(
  value: Localized<T> | T | undefined,
  locale: LocaleCode,
  fallbacks: readonly LocaleCode[] = [],
): T | undefined {
  if (value == null) return undefined;
  if (!isLocalized(value)) return value as T;

  const seen = new Set<string>();
  const chain = [locale, ...expand(locale), ...fallbacks].filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });

  for (const code of chain) {
    const v = (value as Localized<T>)[code];
    if (isPresent(v)) return v;
  }
  return undefined;
}

/** "pt-BR" → ["pt"]; "en" → []. Longest-prefix walk down the BCP47 tag. */
export function expand(code: LocaleCode): LocaleCode[] {
  const parts = code.split("-");
  const out: LocaleCode[] = [];
  for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join("-"));
  return out;
}

/** Detects a plain Localized<T> record vs. a bare string / array / number. */
export function isLocalized<T>(v: unknown): v is Localized<T> {
  if (v == null) return false;
  if (typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  // Heuristic: every own key looks like a BCP47 tag and values share a shape.
  // We accept any non-empty object whose keys match /^[a-z]{2,3}(-[A-Z0-9]{2,4})?$/.
  const tag = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => tag.test(k));
}

function isPresent<T>(v: T | undefined): v is T {
  if (v == null) return false;
  if (typeof v === "string" && v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}
```

The `isLocalized` heuristic is conservative: a customer-typed string like `"en-US visitors only"` is *not* a Localized — it's a bare string. The BCP47-key heuristic rules it out.

### Normalize helpers

```ts
// packages/shared/src/i18n/normalize.ts

/**
 * Wrap a bare T as { [defaultLocale]: T }. Idempotent — already-Localized
 * values pass through. Used on first save after the feature ships so older
 * funnels grow a Localized<T> wrapper opportunistically.
 */
export function liftToLocalized<T>(
  value: Localized<T> | T | undefined,
  defaultLocale: LocaleCode,
): Localized<T> | undefined {
  if (value == null) return undefined;
  if (isLocalized<T>(value)) return value;
  return { [defaultLocale]: value as T };
}

/**
 * Generic walker: for each `obj[field]` that is Localized, apply `fn` and
 * write the result back. Returns a new object (immutable update). The caller
 * supplies the field list, so this stays decoupled from funnel/paywall types.
 */
export function mapLocalizedFields<T extends object>(
  obj: T,
  fields: readonly (keyof T)[],
  fn: (loc: Localized<unknown>) => Localized<unknown> | undefined,
): T;
```

Funnel-specific wrappers live in `apps/dashboard/src/components/funnel-builder/i18n.ts`:

```ts
// apps/dashboard/src/components/funnel-builder/i18n.ts
import { mapLocalizedFields, liftToLocalized } from "@rovenue/shared/i18n";
import { LOCALIZED_PAGE_FIELDS } from "./types";

export function normalizeFunnel(funnel: Funnel): Funnel { /* … */ }

export function mapFunnelLocales(
  funnel: Funnel,
  fn: (loc: Localized<unknown>) => Localized<unknown> | undefined,
): Funnel {
  const pages = funnel.pages.map((p) => mapLocalizedFields(p, LOCALIZED_PAGE_FIELDS, fn));
  // options[].label is nested — handled inline since it's the only nested case
  return { ...funnel, pages };
}
```

The paywall builder declares its own `LOCALIZED_PAYWALL_FIELDS` next to its types and writes a parallel `mapPaywallLocales` — same walker, different field set.

### Funnel schema additions

```ts
// apps/dashboard/src/components/funnel-builder/types.ts (modified)

export type Funnel = {
  // …existing fields…
  defaultLocale: LocaleCode;            // e.g. "en"
  locales: LocaleCode[];                // includes defaultLocale; order = display order in the switcher
};

export type Page = {
  // unchanged: id, type, question_id, required, validation flags, branchCount,
  //   options[].value, options[].imageUrl, productId, trial,
  //   mediaKind, mediaUrl, min, max, step, duration, format,
  //   collectName/Email/Phone, termsUrl, background, footer, showProgress,
  //   showBack, radius

  // string → Localized<string>:
  title?: Localized<string>;
  subtitle?: Localized<string>;
  body?: Localized<string>;
  cta?: Localized<string>;
  headline?: Localized<string>;
  placeholder?: Localized<string>;
  suffix?: Localized<string>;
  agreementLabel?: Localized<string>;

  // Localized arrays:
  benefits?: Localized<string[]>;
  features?: Localized<string[]>;
  steps?: Localized<string[]>;

  // Options: only the visible label is localized.
  options?: { label: Localized<string>; value: string; imageUrl?: string }[];
};
```

`LOCALIZED_PAGE_FIELDS` (in the same file) is the single source of truth that `mapFunnelLocales`, the validation drawer, and the builder UX all consult.

### Runner system-string packs

```
apps/dashboard/src/runner/locales/
  en.json          // ships in v1
  index.ts         // typed loader: getSystemStrings(locale) → SystemStrings
```

```ts
// apps/dashboard/src/runner/locales/index.ts
import en from "./en.json";

export type SystemStrings = {
  cta: { continue: string; back: string; submit: string; tryAgain: string; openApp: string };
  validation: { required: string; invalidEmail: string; invalidPhone: string };
  loading: { default: string };
  legal: { agreeFallback: string };
};

const PACKS: Record<LocaleCode, SystemStrings> = { en: en as SystemStrings };

/** Always returns a complete pack, falling back to en. */
export function getSystemStrings(locale: LocaleCode): SystemStrings {
  return PACKS[locale] ?? PACKS["en"];
}
```

Adding a new system locale is "drop a JSON file + add to `PACKS`". v1 ships `en` only; the structure exists so the paywall builder doesn't have to invent its own.

### Runtime locale selection

```ts
// apps/dashboard/src/runner/use-runner-locale.ts
export function useRunnerLocale(funnel: Funnel): LocaleCode {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("lng") ?? undefined;
  const fromNav = typeof navigator !== "undefined" ? navigator.language : undefined;

  const candidates = [fromUrl, fromNav].filter(Boolean) as string[];
  for (const c of candidates) {
    const hit = matchLocale(c, funnel.locales);
    if (hit) return hit;
  }
  return funnel.defaultLocale;
}

/** Case-insensitive BCP47 match: "PT-br" matches a stored "pt-BR"; falls back
 *  to the language-only prefix ("pt-BR" → "pt") before giving up. */
function matchLocale(input: string, available: readonly LocaleCode[]): LocaleCode | undefined {
  const lower = input.toLowerCase();
  const byCanonical = new Map(available.map((c) => [c.toLowerCase(), c]));
  if (byCanonical.has(lower)) return byCanonical.get(lower)!;
  const primary = lower.split("-")[0];
  if (byCanonical.has(primary)) return byCanonical.get(primary)!;
  return undefined;
}
```

URL beats browser so a customer can share `?lng=tr` previews. Matching is case-insensitive against `funnel.locales` (which stores canonical BCP47, e.g. `pt-BR`), so `?lng=pt-br` and `?lng=PT-BR` both resolve. Allowlist prevents a typo from blanking the screen.

### Builder UX

- **`LocaleSwitcher`** (new): rendered in the builder header next to the existing tabs. Shows current `editLocale` with a dropdown of `funnel.locales`; "+ Add language" opens a small popover that takes a BCP47 code (typeahead from a curated common-locales list, but free-form allowed).
- **`LocalizedInput`** (new): wraps an existing `<input>` / `<textarea>`. Props: `value: Localized<string> | undefined`, `editLocale`, `defaultLocale`, `onChange(next: Localized<string>)`. When `editLocale ≠ defaultLocale` and the locale's value is empty, renders the default-locale value as a greyed placeholder ("English: Continue") inside the input chrome.
- **`LocalizedArrayInput`**: same idea for `benefits[]` / `features[]` / `steps[]`.
- **Removing a language**: confirms with the customer, then runs `mapFunnelLocales(funnel, loc => omit(loc, removed))`. Default locale can't be removed.
- **Validation drawer**: a new `Missing translations` group enumerates `(locale, pageId, field)` tuples where the field is present in `defaultLocale` but missing in another `funnel.locales` entry. Warning, not error — publishing is still allowed.

### Data flow at render

```
Funnel JSON (with Localized<T> fields)
        │
        ▼
useRunnerLocale(funnel) ──► locale: LocaleCode
        │                          │
        ▼                          ▼
funnel.pages[i]                getSystemStrings(locale)
        │                          │
        ▼                          ▼
pick(page.title, locale, [funnel.defaultLocale])      → string | undefined
pick(option.label, locale, [funnel.defaultLocale])    → string | undefined
        │
        ▼
React renders. Missing → renders nothing (or falls back to default via the chain).
```

The runner never receives bare strings; resolution happens at the leaf — in the JSX or in a tiny `localized.tsx` helper component that takes `value` + `locale` + `defaultLocale`.

### Migration story for existing funnels

1. **Read path is back-compat from day one.** `pick()` returns bare strings unchanged, so funnels saved before the feature ships keep rendering.
2. **First save after the feature ships** runs `normalizeFunnel(funnel, defaultLocale)` in the builder's save handler. It:
   - Defaults `funnel.defaultLocale = "en"` and `funnel.locales = ["en"]` if absent.
   - Lifts every bare-string translatable field into `{ [defaultLocale]: value }`.
3. No SQL migration. The funnel config is JSONB; the lifted shape persists naturally.

If we ever want a backfill, it's a one-shot script that reads → normalizes → writes. Out of scope for v1.

## Testing

- **`pick.test.ts`** — table-driven:
  - bare string passes through unchanged
  - exact-locale hit
  - region → language fallback (`pt-BR → pt`)
  - chain fallback (`zh → en` via explicit fallbacks arg)
  - empty string skipped, falls through
  - empty array skipped
  - `undefined` returns `undefined` (no throw)
  - `Localized` heuristic doesn't misclassify `{ foo: "bar" }` (not a locale key)
- **`normalize.test.ts`**:
  - `liftToLocalized` is idempotent
  - already-Localized fields are preserved
  - `mapFunnelLocales` walks every field in `LOCALIZED_PAGE_FIELDS` and ignores untyped fields
- **Builder tests** (Vitest + RTL) in `funnel-builder/__tests__/localized-input.test.tsx`:
  - typing in `tr` doesn't clobber `en`
  - switching `editLocale` swaps the visible value
  - empty `tr` shows the `en` value as greyed placeholder
  - removing `tr` strips `tr` from the funnel
- **Runner test** (`funnel-runner.test.tsx`):
  - `?lng=tr` renders Turkish title for a funnel with `tr` in `funnel.locales`
  - `?lng=zz` (not in allowlist) falls back to `funnel.defaultLocale`
  - region fallback works (`?lng=pt-BR` with only `pt` authored)

All tests are unit / integration-light. No new package-level dependencies — `Intl` is built-in; nothing new in `package.json`.

## Open questions

None blocking v1. The following are explicitly deferred:

- **Where does the paywall builder declare its own `LOCALIZED_*_FIELDS`?** Decide when the paywall builder lands — likely a parallel enum next to its own `Page`/`Block` type.
- **Customer-facing locale picker in the runner?** Some customers may want a "language" switch visible to end users (not just URL-driven). Cheap to add later; not in v1.
- **Telemetry on resolution misses.** Could surface "X% of `tr` sessions saw the `en` fallback for page Y" — useful, but additive and post-MVP.
