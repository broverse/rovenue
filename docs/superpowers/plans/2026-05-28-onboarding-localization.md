# Onboarding Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared, flexible `Localized<T>` value-object system that the funnel builder uses today and the paywall builder will use next — covering both customer-authored content (titles, options, benefits, …) and runner system strings (Continue / Back / validation).

**Architecture:** New `packages/shared/src/i18n/` module exports `Localized<T>` types, a `pick()` resolver with BCP47 region fallback, and a generic `mapLocalizedFields` walker. The funnel builder stores each translatable field as `Localized<T>` inline on `Page`, exposes a header `LocaleSwitcher` + `LocalizedInput` wrappers, and a `resolvePage()` helper flattens a `Page` back to bare strings for `PagePreview` and the runner. System strings live in versioned JSON packs under `apps/dashboard/src/runner/locales/`. No SQL migration — funnel config is JSONB.

**Tech Stack:** TypeScript 5 (strict), React 19, Vite, Vitest + Testing Library, pnpm workspaces, Turborepo. New runtime deps: none.

**Reference spec:** `docs/superpowers/specs/2026-05-28-onboarding-localization-design.md`

---

## File map

### Create
- `packages/shared/src/i18n/types.ts` — `Localized<T>`, `LocaleCode`, `LocaleSet`
- `packages/shared/src/i18n/pick.ts` — `pick()`, `expand()`, `isLocalized()`
- `packages/shared/src/i18n/pick.test.ts`
- `packages/shared/src/i18n/normalize.ts` — `liftToLocalized()`, `mapLocalizedFields()`
- `packages/shared/src/i18n/normalize.test.ts`
- `packages/shared/src/i18n/index.ts` — barrel
- `apps/dashboard/src/components/funnel-builder/i18n.ts` — `LOCALIZED_PAGE_FIELDS`, `normalizeFunnel`, `mapFunnelLocales`, `resolvePage`
- `apps/dashboard/src/components/funnel-builder/i18n.test.ts`
- `apps/dashboard/src/components/funnel-builder/localized-input.tsx` — `LocalizedInput`, `LocalizedTextarea`, `LocalizedArrayInput`
- `apps/dashboard/src/components/funnel-builder/__tests__/localized-input.test.tsx`
- `apps/dashboard/src/components/funnel-builder/locale-switcher.tsx`
- `apps/dashboard/src/components/funnel-builder/__tests__/locale-switcher.test.tsx`
- `apps/dashboard/src/runner/locales/en.json`
- `apps/dashboard/src/runner/locales/index.ts` — `SystemStrings`, `getSystemStrings`
- `apps/dashboard/src/runner/use-runner-locale.ts`
- `apps/dashboard/src/runner/use-runner-locale.test.ts`

### Modify
- `packages/shared/src/index.ts` — re-export i18n barrel
- `packages/shared/package.json` — add `./i18n` subpath export
- `apps/dashboard/src/components/funnel-builder/types.ts` — `string → Localized<string>` on translatable fields; add `Funnel.defaultLocale` + `Funnel.locales`; rewrite `toEvalPage` to call `resolvePage`
- `apps/dashboard/src/components/funnel-builder/page-preview.tsx` — accept `locale`/`defaultLocale` props and pass through `resolvePage`
- `apps/dashboard/src/components/funnel-builder/properties-panel.tsx` — swap `<input>`/`<textarea>` for `<LocalizedInput>`/`<LocalizedTextarea>`/`<LocalizedArrayInput>` on every translatable field
- `apps/dashboard/src/components/funnel-builder/builder-shell.tsx` — mount `<LocaleSwitcher>`
- `apps/dashboard/src/components/funnel-builder/validation-drawer.tsx` — append missing-translation warnings
- `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts` — `editLocale` state; `addLocale`/`removeLocale`/`setEditLocale` actions; `normalizeFunnel` on load; update `toEvalPage(...)` call with new locale arg
- `apps/dashboard/src/components/funnel-builder/vm/funnel-preview.vm.ts` — pass `editLocale` into its two `toEvalPage(...)` calls
- `apps/dashboard/src/runner/funnel-runner.tsx` — resolve locale + pass to `PagePreview` + use `SystemStrings`

---

## Task 1: Shared `Localized<T>` types + `pick()` resolver (TDD)

**Files:**
- Create: `packages/shared/src/i18n/types.ts`
- Create: `packages/shared/src/i18n/pick.ts`
- Create: `packages/shared/src/i18n/pick.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/i18n/pick.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expand, isLocalized, pick } from "./pick";

describe("expand", () => {
  it("walks longest-prefix down BCP47 tags", () => {
    expect(expand("pt-BR")).toEqual(["pt"]);
    expect(expand("zh-Hans-CN")).toEqual(["zh-Hans", "zh"]);
    expect(expand("en")).toEqual([]);
  });
});

describe("isLocalized", () => {
  it("accepts a plain object whose every key is a BCP47 tag", () => {
    expect(isLocalized({ en: "x", tr: "y" })).toBe(true);
    expect(isLocalized({ "pt-BR": "x" })).toBe(true);
  });
  it("rejects bare values and non-locale-keyed objects", () => {
    expect(isLocalized("hello")).toBe(false);
    expect(isLocalized(null)).toBe(false);
    expect(isLocalized(undefined)).toBe(false);
    expect(isLocalized([])).toBe(false);
    expect(isLocalized(["en", "tr"])).toBe(false);
    expect(isLocalized({ name: "x" })).toBe(false);      // "name" isn't BCP47
    expect(isLocalized({ id: "x", name: "y" })).toBe(false); // mixed keys
    expect(isLocalized({})).toBe(false);                  // empty
  });
});

describe("pick", () => {
  it("returns undefined when value is null/undefined", () => {
    expect(pick(undefined, "en")).toBeUndefined();
    expect(pick(null as unknown as undefined, "en")).toBeUndefined();
  });
  it("returns a bare value unchanged (back-compat)", () => {
    expect(pick("hello", "en")).toBe("hello");
    expect(pick(42 as unknown as never, "en")).toBe(42);
  });
  it("hits an exact locale", () => {
    expect(pick({ en: "Continue", tr: "Devam" }, "tr")).toBe("Devam");
  });
  it("falls back via BCP47 region walk", () => {
    expect(pick({ pt: "Continuar" }, "pt-BR")).toBe("Continuar");
  });
  it("uses explicit fallbacks after the region walk", () => {
    expect(pick({ en: "Continue" }, "zh", ["en"])).toBe("Continue");
  });
  it("skips empty strings and empty arrays", () => {
    expect(pick({ en: "", tr: "Devam" }, "en", ["tr"])).toBe("Devam");
    expect(pick({ en: [], tr: ["a"] }, "en", ["tr"])).toEqual(["a"]);
  });
  it("returns undefined when nothing in the chain matches", () => {
    expect(pick({ en: "x" }, "tr")).toBeUndefined();
  });
  it("dedupes the resolution chain", () => {
    // explicit fallback ["en"] equals the eventual default; no infinite loop / double work
    expect(pick({ en: "x" }, "en", ["en"])).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/shared test -- pick.test`
Expected: FAIL — module `./pick` not found.

- [ ] **Step 3: Write `types.ts`**

Create `packages/shared/src/i18n/types.ts`:

```ts
/**
 * BCP47 language tag, e.g. "en", "tr", "pt-BR". The resolver treats this as
 * opaque text and only ever compares-or-prefixes — there is no enum.
 */
export type LocaleCode = string;

/**
 * A value that varies by locale. Keys that are absent (or hold "" / [])
 * fall through to the resolver's fallback chain.
 */
export type Localized<T> = { readonly [locale: LocaleCode]: T };

/**
 * Per-funnel (or per-paywall) locale configuration. `default` is also the
 * resolver's terminal fallback.
 */
export type LocaleSet = {
  default: LocaleCode;
  available: readonly LocaleCode[];
};
```

- [ ] **Step 4: Write `pick.ts`**

Create `packages/shared/src/i18n/pick.ts`:

```ts
import type { Localized, LocaleCode } from "./types";

/**
 * Resolve a possibly-localized value for the requested locale.
 *
 * Accepts a bare T (treated as already-resolved) so historical data
 * predating Localized<T> still renders. Empty strings and empty arrays are
 * treated as missing and fall through to the next candidate.
 */
export function pick<T>(
  value: Localized<T> | T | undefined,
  locale: LocaleCode,
  fallbacks: readonly LocaleCode[] = [],
): T | undefined {
  if (value == null) return undefined;
  if (!isLocalized<T>(value)) return value as T;

  const seen = new Set<string>();
  const chain: LocaleCode[] = [];
  for (const c of [locale, ...expand(locale), ...fallbacks]) {
    if (seen.has(c)) continue;
    seen.add(c);
    chain.push(c);
  }

  for (const code of chain) {
    const v = (value as Localized<T>)[code];
    if (isPresent(v)) return v;
  }
  return undefined;
}

/** "pt-BR" → ["pt"]; "zh-Hans-CN" → ["zh-Hans", "zh"]; "en" → []. */
export function expand(code: LocaleCode): LocaleCode[] {
  const parts = code.split("-");
  const out: LocaleCode[] = [];
  for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join("-"));
  return out;
}

/**
 * Detects a plain Localized<T> record vs a bare value. The heuristic
 * requires every own key to look like a BCP47 tag and at least one key to
 * be present; that's enough to disambiguate from arbitrary plain objects
 * the codebase doesn't otherwise put through this resolver.
 */
export function isLocalized<T>(v: unknown): v is Localized<T> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  if (keys.length === 0) return false;
  const tag = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4}){0,2}$/;
  return keys.every((k) => tag.test(k));
}

function isPresent<T>(v: T | undefined): v is T {
  if (v == null) return false;
  if (typeof v === "string" && v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rovenue/shared test -- pick.test`
Expected: PASS (all `it` blocks green).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/i18n/types.ts packages/shared/src/i18n/pick.ts packages/shared/src/i18n/pick.test.ts
git commit -m "feat(shared): add Localized<T> types and pick() resolver"
```

---

## Task 2: Shared normalize helpers (TDD)

**Files:**
- Create: `packages/shared/src/i18n/normalize.ts`
- Create: `packages/shared/src/i18n/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/i18n/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { liftToLocalized, mapLocalizedFields } from "./normalize";

describe("liftToLocalized", () => {
  it("wraps a bare string under the default locale", () => {
    expect(liftToLocalized("Continue", "en")).toEqual({ en: "Continue" });
  });
  it("wraps a bare array under the default locale", () => {
    expect(liftToLocalized(["a", "b"], "en")).toEqual({ en: ["a", "b"] });
  });
  it("returns undefined for null/undefined", () => {
    expect(liftToLocalized(undefined, "en")).toBeUndefined();
  });
  it("is idempotent on an already-Localized value", () => {
    const v = { en: "Continue", tr: "Devam" };
    expect(liftToLocalized(v, "en")).toBe(v);
  });
});

describe("mapLocalizedFields", () => {
  type Page = { id: string; title?: { en?: string; tr?: string }; subtitle?: { en?: string } };
  const page: Page = { id: "p1", title: { en: "A", tr: "B" }, subtitle: { en: "C" } };

  it("applies fn to every listed Localized field and returns a new object", () => {
    const next = mapLocalizedFields(page, ["title", "subtitle"], (loc) => {
      const { tr, ...rest } = loc as { tr?: unknown };
      void tr;
      return rest as typeof loc;
    });
    expect(next).not.toBe(page);
    expect(next.title).toEqual({ en: "A" });
    expect(next.subtitle).toEqual({ en: "C" });
    expect(next.id).toBe("p1");
  });

  it("leaves bare-value fields untouched", () => {
    const messy: { id: string; title?: string | { en: string } } = { id: "p", title: "bare" };
    const next = mapLocalizedFields(messy, ["title"], (loc) => loc);
    expect(next.title).toBe("bare");
  });

  it("drops a field when fn returns undefined", () => {
    const next = mapLocalizedFields(page, ["title"], () => undefined);
    expect(next.title).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/shared test -- normalize.test`
Expected: FAIL — module `./normalize` not found.

- [ ] **Step 3: Write `normalize.ts`**

Create `packages/shared/src/i18n/normalize.ts`:

```ts
import { isLocalized } from "./pick";
import type { Localized, LocaleCode } from "./types";

/**
 * Wrap a bare T as { [defaultLocale]: T }. Idempotent — already-Localized
 * values pass through. Used on first save / load so older funnels grow a
 * Localized<T> wrapper opportunistically.
 */
export function liftToLocalized<T>(
  value: Localized<T> | T | undefined,
  defaultLocale: LocaleCode,
): Localized<T> | undefined {
  if (value == null) return undefined;
  if (isLocalized<T>(value)) return value;
  return { [defaultLocale]: value } as Localized<T>;
}

/**
 * For each `obj[field]` that is a Localized<unknown>, apply `fn` and write
 * the result back (or delete the field when `fn` returns undefined).
 * Returns a new object — never mutates the input. Bare values on listed
 * fields are left untouched.
 *
 * Generic on purpose: paywall builder declares its own field list and
 * reuses the same walker.
 */
export function mapLocalizedFields<T extends object>(
  obj: T,
  fields: readonly (keyof T)[],
  fn: (loc: Localized<unknown>) => Localized<unknown> | undefined,
): T {
  const next: T = { ...obj };
  for (const field of fields) {
    const v = next[field];
    if (!isLocalized<unknown>(v)) continue;
    const out = fn(v);
    if (out === undefined) {
      delete next[field];
    } else {
      next[field] = out as T[typeof field];
    }
  }
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/shared test -- normalize.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/i18n/normalize.ts packages/shared/src/i18n/normalize.test.ts
git commit -m "feat(shared): add liftToLocalized + mapLocalizedFields"
```

---

## Task 3: Wire `@rovenue/shared/i18n` subpath export

**Files:**
- Create: `packages/shared/src/i18n/index.ts`
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the barrel**

Create `packages/shared/src/i18n/index.ts`:

```ts
export type { Localized, LocaleCode, LocaleSet } from "./types";
export { pick, expand, isLocalized } from "./pick";
export { liftToLocalized, mapLocalizedFields } from "./normalize";
```

- [ ] **Step 2: Add subpath export to `packages/shared/package.json`**

Add inside the `"exports"` object (alongside the existing `./funnel`, `./notifications`, etc.):

```json
"./i18n": {
  "types": "./src/i18n/index.ts",
  "default": "./src/i18n/index.ts"
}
```

- [ ] **Step 3: Re-export from the top-level barrel**

Append to `packages/shared/src/index.ts`:

```ts
// =============================================================
// i18n primitives — reusable by funnel + paywall builders
// =============================================================
export type { Localized, LocaleCode, LocaleSet } from "./i18n";
export { pick, expand, isLocalized, liftToLocalized, mapLocalizedFields } from "./i18n";
```

- [ ] **Step 4: Verify the package builds and tests still pass**

Run: `pnpm --filter @rovenue/shared build && pnpm --filter @rovenue/shared test`
Expected: PASS, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/i18n/index.ts packages/shared/src/index.ts packages/shared/package.json
git commit -m "feat(shared): export @rovenue/shared/i18n subpath"
```

---

## Task 4: Update `funnel-builder/types.ts` — Localized fields + locale config

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/types.ts`

This task only changes types; runtime behavior is covered by tasks that follow. `toEvalPage` is rewritten to call `resolvePage` (Task 5) once that helper exists — for now we route through a lightweight inline resolver to keep `toEvalPage` working in isolation.

- [ ] **Step 1: Add the import**

At the top of `apps/dashboard/src/components/funnel-builder/types.ts`, after the existing lucide imports:

```ts
import type { Localized, LocaleCode } from "@rovenue/shared/i18n";
import { pick } from "@rovenue/shared/i18n";
```

- [ ] **Step 2: Update `Option` and `Page` types**

Replace the existing `Option` and `Page` declarations (currently at the lines defining `export type Option = …` and `export type Page = …`) with:

```ts
export type Option = { label: Localized<string>; value: string; imageUrl?: string };

export type Page = {
  id: string;
  type: PageType;
  question_id?: string;

  // Localized<string> content:
  title?: Localized<string>;
  subtitle?: Localized<string>;
  body?: Localized<string>;
  cta?: Localized<string>;
  headline?: Localized<string>;
  placeholder?: Localized<string>;
  suffix?: Localized<string>;
  agreementLabel?: Localized<string>;

  // Localized<string[]> content:
  benefits?: Localized<string[]>;
  features?: Localized<string[]>;
  steps?: Localized<string[]>;

  // Unchanged structural / non-text fields:
  required?: boolean;
  branchCount?: number;
  validation_errors?: number;
  options?: Option[];
  min?: number;
  max?: number;
  step?: number;
  format?: string;
  max_selections?: number;
  duration?: number;
  productId?: string;
  trial?: number;
  mediaKind?: "none" | "image" | "video";
  mediaUrl?: string;
  collectName?: boolean;
  collectEmail?: boolean;
  collectPhone?: boolean;
  termsUrl?: string;
  background?: PageBackground;
  footer?: PageFooter;
  showProgress?: boolean;
  showBack?: boolean;
  radius?: number;
};

/** Single source of truth for which Page fields are Localized<…>. */
export const LOCALIZED_PAGE_FIELDS = [
  "title", "subtitle", "body", "cta", "headline",
  "placeholder", "suffix", "agreementLabel",
  "benefits", "features", "steps",
] as const satisfies readonly (keyof Page)[];
```

- [ ] **Step 3: Update the `Funnel` type**

Replace the existing `export type Funnel = { … }` with:

```ts
export type Funnel = {
  id: string;
  name: string;
  slug: string;
  status: "draft" | "published" | "archived";
  version: number;
  draftDiffersFromPublished: boolean;
  theme: Theme;
  settings: Settings;
  pages: Page[];
  rules: Record<string, Rule[]>;
  default_next: Record<string, string | null>;

  /** Canonical authoring locale; resolver's terminal fallback. */
  defaultLocale: LocaleCode;
  /** All locales the funnel may render in. Includes defaultLocale. Order = switcher display order. */
  locales: LocaleCode[];
};
```

- [ ] **Step 4: Rewrite `toEvalPage`**

Replace the existing `toEvalPage` function with a locale-aware version. (Eval is a server-side concept; we resolve to the default locale by default — branching only sees structural answers, not content strings.)

```ts
/**
 * Convert dashboard's flat Page into the shared validator/evaluator shape.
 * Content fields are resolved against `locale` so the evaluator's pre-flight
 * preview reflects what an end-user would see; structural fields are passed
 * through. `value` on options is intentionally not localized (branching
 * compares on stable ids).
 */
export function toEvalPage(
  p: Page,
  locale: LocaleCode,
  rules?: unknown[],
  defaultNext?: string,
): {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next_rules?: unknown[];
  default_next?: string;
} {
  return {
    id: p.id,
    type: p.type,
    config: {
      question_id: p.question_id,
      title: pick(p.title, locale),
      subtitle: pick(p.subtitle, locale),
      headline: pick(p.headline, locale),
      body_markdown: pick(p.body, locale),
      body: pick(p.body, locale),
      options: p.options?.map((o) => ({
        label: pick(o.label, locale),
        value: o.value,
        imageUrl: o.imageUrl,
      })),
      min: p.min,
      max: p.max,
      step: p.step,
      suffix: pick(p.suffix, locale),
      duration_ms: p.duration,
      steps: pick(p.steps, locale),
      product_id: p.productId,
      bullets: pick(p.benefits, locale),
      open_app_label: pick(p.cta, locale),
    },
    next_rules: rules,
    default_next: defaultNext,
  };
}
```

- [ ] **Step 5: Type-check the package**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: TypeScript errors in `properties-panel.tsx`, `page-preview.tsx`, `funnel-runner.tsx`, `validation-drawer.tsx`, and the VM — these are fixed by later tasks. No errors in `types.ts` itself.

If you see "Cannot find module `@rovenue/shared/i18n`", recheck the `exports` entry in Task 3.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/types.ts
git commit -m "feat(funnel-builder): Localized<T> page fields + funnel locale config

- Funnel.defaultLocale + Funnel.locales
- LOCALIZED_PAGE_FIELDS enumerates translatable fields once
- toEvalPage now resolves content against a locale arg

Downstream consumers (properties-panel, page-preview, runner, VM, validator)
are updated in the next tasks."
```

---

## Task 5: `funnel-builder/i18n.ts` — funnel-specific wrappers + tests (TDD)

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/i18n.ts`
- Create: `apps/dashboard/src/components/funnel-builder/i18n.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/funnel-builder/i18n.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeFunnel, mapFunnelLocales, resolvePage } from "./i18n";
import type { Funnel, Page } from "./types";

function bareFunnel(overrides: Partial<Funnel> = {}): Funnel {
  return {
    id: "f1",
    name: "F",
    slug: "f",
    status: "draft",
    version: 1,
    draftDiffersFromPublished: false,
    theme: {} as Funnel["theme"],
    settings: {} as Funnel["settings"],
    pages: [],
    rules: {},
    default_next: {},
    defaultLocale: "en",
    locales: ["en"],
    ...overrides,
  };
}

describe("normalizeFunnel", () => {
  it("defaults locale config when absent (legacy data)", () => {
    const f = { ...bareFunnel(), defaultLocale: undefined as unknown as string, locales: undefined as unknown as string[] };
    const out = normalizeFunnel(f);
    expect(out.defaultLocale).toBe("en");
    expect(out.locales).toEqual(["en"]);
  });

  it("lifts bare-string page fields into Localized<string>", () => {
    const f = bareFunnel({
      pages: [{ id: "p1", type: "welcome", title: "Hi" as unknown as Page["title"] }],
    });
    const out = normalizeFunnel(f);
    expect(out.pages[0].title).toEqual({ en: "Hi" });
  });

  it("lifts bare-string Option.label", () => {
    const f = bareFunnel({
      pages: [{
        id: "p1", type: "single_choice",
        options: [{ label: "Yes" as unknown as Page["options"][number]["label"], value: "y" }],
      }],
    });
    const out = normalizeFunnel(f);
    expect(out.pages[0].options?.[0].label).toEqual({ en: "Yes" });
  });

  it("is idempotent", () => {
    const f = bareFunnel({
      pages: [{ id: "p1", type: "welcome", title: { en: "Hi" } }],
    });
    expect(normalizeFunnel(normalizeFunnel(f))).toEqual(normalizeFunnel(f));
  });
});

describe("mapFunnelLocales", () => {
  it("applies fn to every Localized<T> field across pages + options", () => {
    const f = bareFunnel({
      pages: [
        { id: "p1", type: "welcome", title: { en: "Hi", tr: "Selam" }, subtitle: { en: "Welcome" } },
        { id: "p2", type: "single_choice",
          options: [{ label: { en: "Yes", tr: "Evet" }, value: "y" }] },
      ],
      locales: ["en", "tr"],
    });
    const stripTr = mapFunnelLocales(f, (loc) => {
      const { tr, ...rest } = loc as { tr?: unknown };
      void tr;
      return rest as typeof loc;
    });
    expect(stripTr.pages[0].title).toEqual({ en: "Hi" });
    expect(stripTr.pages[1].options?.[0].label).toEqual({ en: "Yes" });
  });
});

describe("resolvePage", () => {
  it("flattens Localized fields and Option.label into bare values", () => {
    const page: Page = {
      id: "p1", type: "welcome",
      title: { en: "Hello", tr: "Merhaba" },
      benefits: { en: ["a", "b"] },
      options: [{ label: { en: "Yes", tr: "Evet" }, value: "y" }],
    };
    const en = resolvePage(page, "en", "en");
    expect(en.title).toBe("Hello");
    expect(en.benefits).toEqual(["a", "b"]);
    expect(en.options?.[0].label).toBe("Yes");

    const tr = resolvePage(page, "tr", "en");
    expect(tr.title).toBe("Merhaba");
    expect(tr.options?.[0].label).toBe("Evet");
  });

  it("falls back to defaultLocale when the requested locale is missing", () => {
    const page: Page = { id: "p1", type: "welcome", title: { en: "Hello" } };
    expect(resolvePage(page, "zz", "en").title).toBe("Hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard test -- funnel-builder/i18n.test`
Expected: FAIL — module `./i18n` not found.

- [ ] **Step 3: Write `i18n.ts`**

Create `apps/dashboard/src/components/funnel-builder/i18n.ts`:

```ts
import {
  liftToLocalized,
  mapLocalizedFields,
  pick,
  type LocaleCode,
  type Localized,
} from "@rovenue/shared/i18n";
import { LOCALIZED_PAGE_FIELDS, type Funnel, type Option, type Page } from "./types";

/**
 * Lift any bare-string legacy data into Localized<…> and guarantee that
 * `defaultLocale` / `locales` are populated. Safe to call on every load
 * and every save — idempotent.
 */
export function normalizeFunnel(funnel: Funnel): Funnel {
  const defaultLocale = funnel.defaultLocale || "en";
  const locales = funnel.locales?.length ? funnel.locales : [defaultLocale];

  const pages = funnel.pages.map((page) => {
    const lifted = mapLocalizedOrBareFields(page, LOCALIZED_PAGE_FIELDS, defaultLocale);
    if (!lifted.options) return lifted;
    return {
      ...lifted,
      options: lifted.options.map((o) => ({
        ...o,
        label: liftToLocalized(o.label as Localized<string> | string | undefined, defaultLocale)
          ?? ({ [defaultLocale]: "" } as Localized<string>),
      })),
    };
  });

  return { ...funnel, defaultLocale, locales, pages };
}

/**
 * Apply fn to every Localized<T> field on every page (including
 * Option.label). Used when adding/removing a language at funnel-level.
 */
export function mapFunnelLocales(
  funnel: Funnel,
  fn: (loc: Localized<unknown>) => Localized<unknown> | undefined,
): Funnel {
  const pages = funnel.pages.map((page) => {
    const mapped = mapLocalizedFields(page, LOCALIZED_PAGE_FIELDS, fn);
    if (!mapped.options) return mapped;
    return {
      ...mapped,
      options: mapped.options.map((o) => {
        const next = fn(o.label as Localized<unknown>);
        return next === undefined ? { ...o, label: {} as Localized<string> } : { ...o, label: next as Localized<string> };
      }),
    };
  });
  return { ...funnel, pages };
}

/**
 * Flatten every Localized<T> field on a Page into bare values for the
 * given locale. Output reuses Page's field names so PagePreview and the
 * runner can stay locale-agnostic.
 */
export type ResolvedPage = Omit<Page, (typeof LOCALIZED_PAGE_FIELDS)[number] | "options"> & {
  title?: string;
  subtitle?: string;
  body?: string;
  cta?: string;
  headline?: string;
  placeholder?: string;
  suffix?: string;
  agreementLabel?: string;
  benefits?: string[];
  features?: string[];
  steps?: string[];
  options?: { label: string; value: string; imageUrl?: string }[];
};

export function resolvePage(
  page: Page,
  locale: LocaleCode,
  defaultLocale: LocaleCode,
): ResolvedPage {
  const fb: LocaleCode[] = locale === defaultLocale ? [] : [defaultLocale];
  const out: ResolvedPage = { ...page } as ResolvedPage;
  for (const field of LOCALIZED_PAGE_FIELDS) {
    const v = page[field];
    (out as Record<string, unknown>)[field] = pick(v as never, locale, fb);
  }
  if (page.options) {
    out.options = page.options.map((o) => ({
      label: pick(o.label, locale, fb) ?? "",
      value: o.value,
      imageUrl: o.imageUrl,
    }));
  }
  return out;
}

/**
 * Like mapLocalizedFields but also lifts bare values into
 * `{ [defaultLocale]: value }` along the way. Used by normalizeFunnel.
 */
function mapLocalizedOrBareFields(
  page: Page,
  fields: readonly (keyof Page)[],
  defaultLocale: LocaleCode,
): Page {
  const next: Page = { ...page };
  for (const field of fields) {
    const v = next[field];
    if (v == null) continue;
    const lifted = liftToLocalized(v as Localized<unknown> | unknown, defaultLocale);
    if (lifted !== undefined) {
      next[field] = lifted as Page[typeof field];
    }
  }
  return next;
}

// Keep Option exported here too so consumers don't need two imports.
export type { Option };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- funnel-builder/i18n.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/i18n.ts apps/dashboard/src/components/funnel-builder/i18n.test.ts
git commit -m "feat(funnel-builder): add normalizeFunnel, mapFunnelLocales, resolvePage"
```

---

## Task 6: Runner system-string pack (`en.json` + loader)

**Files:**
- Create: `apps/dashboard/src/runner/locales/en.json`
- Create: `apps/dashboard/src/runner/locales/index.ts`

- [ ] **Step 1: Write `en.json`**

Create `apps/dashboard/src/runner/locales/en.json`:

```json
{
  "cta": {
    "continue": "Continue",
    "back": "Back",
    "submit": "Submit",
    "tryAgain": "Try again",
    "openApp": "Open app",
    "getStarted": "Get started"
  },
  "validation": {
    "required": "This field is required",
    "invalidEmail": "Enter a valid email address",
    "invalidPhone": "Enter a valid phone number"
  },
  "loading": {
    "default": "Just a moment…"
  },
  "legal": {
    "agreeFallback": "I agree"
  }
}
```

- [ ] **Step 2: Write the loader**

Create `apps/dashboard/src/runner/locales/index.ts`:

```ts
import type { LocaleCode } from "@rovenue/shared/i18n";
import en from "./en.json";

export type SystemStrings = {
  cta: {
    continue: string;
    back: string;
    submit: string;
    tryAgain: string;
    openApp: string;
    getStarted: string;
  };
  validation: {
    required: string;
    invalidEmail: string;
    invalidPhone: string;
  };
  loading: { default: string };
  legal: { agreeFallback: string };
};

const PACKS: Record<LocaleCode, SystemStrings> = {
  en: en as SystemStrings,
};

/** Always returns a complete pack. Falls back to "en" for unknown locales. */
export function getSystemStrings(locale: LocaleCode): SystemStrings {
  return PACKS[locale] ?? PACKS.en;
}

/** Locale codes we ship a pack for. Adding "tr.json" + an entry in PACKS is enough. */
export function availableSystemLocales(): LocaleCode[] {
  return Object.keys(PACKS);
}
```

- [ ] **Step 3: Verify TS configuration accepts JSON imports**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit apps/dashboard/src/runner/locales/index.ts`
Expected: PASS (the dashboard's `tsconfig.json` already sets `"resolveJsonModule": true` via the Vite default; verify by skimming `apps/dashboard/tsconfig.json` if there's an error).

If you see "Cannot find module './en.json' or its corresponding type declarations", add `"resolveJsonModule": true` and `"esModuleInterop": true` to `apps/dashboard/tsconfig.json` under `compilerOptions`.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/runner/locales/en.json apps/dashboard/src/runner/locales/index.ts
git commit -m "feat(runner): add SystemStrings pack and getSystemStrings loader"
```

---

## Task 7: `useRunnerLocale` hook (TDD)

**Files:**
- Create: `apps/dashboard/src/runner/use-runner-locale.ts`
- Create: `apps/dashboard/src/runner/use-runner-locale.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/runner/use-runner-locale.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { matchLocale, resolveRunnerLocale } from "./use-runner-locale";

describe("matchLocale", () => {
  it("is case-insensitive against the available list", () => {
    expect(matchLocale("PT-br", ["pt-BR", "en"])).toBe("pt-BR");
    expect(matchLocale("en", ["en"])).toBe("en");
  });
  it("falls back to the primary subtag", () => {
    expect(matchLocale("pt-BR", ["pt"])).toBe("pt");
  });
  it("returns undefined when nothing matches", () => {
    expect(matchLocale("zz", ["en", "tr"])).toBeUndefined();
  });
});

describe("resolveRunnerLocale", () => {
  const funnel = { defaultLocale: "en", locales: ["en", "tr", "pt-BR"] };

  it("prefers ?lng= when present and allowed", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app?lng=tr", nav: "en-US" })).toBe("tr");
  });
  it("falls back to navigator.language", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app", nav: "tr-TR" })).toBe("tr");
  });
  it("falls back to defaultLocale when neither matches", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app", nav: "ja-JP" })).toBe("en");
  });
  it("ignores ?lng= values not in the allowlist", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app?lng=zz", nav: "tr-TR" })).toBe("tr");
  });
  it("matches pt-BR exactly when URL is lowercased", () => {
    expect(resolveRunnerLocale(funnel, { url: "https://x.app?lng=pt-br", nav: "en" })).toBe("pt-BR");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard test -- use-runner-locale.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `use-runner-locale.ts`**

Create `apps/dashboard/src/runner/use-runner-locale.ts`:

```ts
import { useMemo } from "react";
import type { LocaleCode } from "@rovenue/shared/i18n";

interface FunnelLocaleConfig {
  defaultLocale: LocaleCode;
  locales: readonly LocaleCode[];
}

/** Pure resolver — extracted for unit-testing without DOM. */
export function resolveRunnerLocale(
  funnel: FunnelLocaleConfig,
  src: { url: string; nav: string | undefined },
): LocaleCode {
  const fromUrl = new URL(src.url).searchParams.get("lng") ?? undefined;
  const candidates = [fromUrl, src.nav].filter(Boolean) as string[];
  for (const c of candidates) {
    const hit = matchLocale(c, funnel.locales);
    if (hit) return hit;
  }
  return funnel.defaultLocale;
}

/**
 * Case-insensitive BCP47 match. Falls back to the primary subtag before
 * giving up — so "pt-BR" can match a stored "pt".
 */
export function matchLocale(
  input: string,
  available: readonly LocaleCode[],
): LocaleCode | undefined {
  const lower = input.toLowerCase();
  const byCanonical = new Map(available.map((c) => [c.toLowerCase(), c]));
  if (byCanonical.has(lower)) return byCanonical.get(lower)!;
  const primary = lower.split("-")[0];
  if (byCanonical.has(primary)) return byCanonical.get(primary)!;
  return undefined;
}

/** React-facing wrapper. Stable per (locale-config, href). */
export function useRunnerLocale(funnel: FunnelLocaleConfig): LocaleCode {
  return useMemo(
    () =>
      resolveRunnerLocale(funnel, {
        url: typeof window !== "undefined" ? window.location.href : "https://localhost",
        nav: typeof navigator !== "undefined" ? navigator.language : undefined,
      }),
    [funnel.defaultLocale, funnel.locales.join(","), typeof window !== "undefined" ? window.location.search : ""],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- use-runner-locale.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/runner/use-runner-locale.ts apps/dashboard/src/runner/use-runner-locale.test.ts
git commit -m "feat(runner): add useRunnerLocale hook with URL+nav+default fallback chain"
```

---

## Task 8: `<LocalizedInput>` / `<LocalizedTextarea>` / `<LocalizedArrayInput>` (TDD)

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/localized-input.tsx`
- Create: `apps/dashboard/src/components/funnel-builder/__tests__/localized-input.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/funnel-builder/__tests__/localized-input.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LocalizedInput, LocalizedTextarea, LocalizedArrayInput } from "../localized-input";

describe("<LocalizedInput>", () => {
  it("shows the value for editLocale", () => {
    render(<LocalizedInput value={{ en: "Hi", tr: "Selam" }} editLocale="tr" defaultLocale="en" onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toHaveValue("Selam");
  });

  it("only writes the editLocale key", () => {
    const onChange = vi.fn();
    render(<LocalizedInput value={{ en: "Hi", tr: "Selam" }} editLocale="tr" defaultLocale="en" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Merhaba" } });
    expect(onChange).toHaveBeenCalledWith({ en: "Hi", tr: "Merhaba" });
  });

  it("falls back to defaultLocale as greyed placeholder when editLocale is empty", () => {
    render(
      <LocalizedInput value={{ en: "Hi" }} editLocale="tr" defaultLocale="en" onChange={() => {}} />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", expect.stringMatching(/Hi/));
  });

  it("works on undefined value (treats as empty)", () => {
    const onChange = vi.fn();
    render(<LocalizedInput value={undefined} editLocale="en" defaultLocale="en" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hi" } });
    expect(onChange).toHaveBeenCalledWith({ en: "Hi" });
  });
});

describe("<LocalizedArrayInput>", () => {
  it("renders rows for editLocale's array and writes back", () => {
    const onChange = vi.fn();
    render(
      <LocalizedArrayInput
        value={{ en: ["a", "b"], tr: ["x", "y"] }}
        editLocale="tr"
        defaultLocale="en"
        onChange={onChange}
      />,
    );
    const inputs = screen.getAllByRole("textbox");
    expect(inputs.map((i) => (i as HTMLInputElement).value)).toEqual(["x", "y"]);

    fireEvent.change(inputs[0], { target: { value: "X1" } });
    expect(onChange).toHaveBeenCalledWith({ en: ["a", "b"], tr: ["X1", "y"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard test -- localized-input.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `localized-input.tsx`**

Create `apps/dashboard/src/components/funnel-builder/localized-input.tsx`:

```tsx
import { useCallback } from "react";
import type { ChangeEvent, InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import type { Localized, LocaleCode } from "@rovenue/shared/i18n";

type Base<E extends HTMLElement> = {
  value: Localized<string> | undefined;
  editLocale: LocaleCode;
  defaultLocale: LocaleCode;
  onChange: (next: Localized<string>) => void;
  placeholder?: string;
} & Omit<InputHTMLAttributes<E> | TextareaHTMLAttributes<E>, "value" | "onChange" | "placeholder">;

function resolvePlaceholder(
  value: Localized<string> | undefined,
  editLocale: LocaleCode,
  defaultLocale: LocaleCode,
  fallback: string | undefined,
): string | undefined {
  if (editLocale === defaultLocale) return fallback;
  const def = value?.[defaultLocale];
  return def && def !== "" ? def : fallback;
}

function writeKey(
  value: Localized<string> | undefined,
  key: LocaleCode,
  next: string,
): Localized<string> {
  return { ...(value ?? {}), [key]: next };
}

export function LocalizedInput(
  props: Base<HTMLInputElement> & { type?: "text" | "url" | "email" },
) {
  const { value, editLocale, defaultLocale, onChange, placeholder, type = "text", ...rest } = props;
  const current = value?.[editLocale] ?? "";
  const handle = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => onChange(writeKey(value, editLocale, e.target.value)),
    [value, editLocale, onChange],
  );
  return (
    <input
      {...(rest as InputHTMLAttributes<HTMLInputElement>)}
      type={type}
      value={current}
      placeholder={resolvePlaceholder(value, editLocale, defaultLocale, placeholder)}
      onChange={handle}
    />
  );
}

export function LocalizedTextarea(props: Base<HTMLTextAreaElement> & { rows?: number }) {
  const { value, editLocale, defaultLocale, onChange, placeholder, rows = 3, ...rest } = props;
  const current = value?.[editLocale] ?? "";
  const handle = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => onChange(writeKey(value, editLocale, e.target.value)),
    [value, editLocale, onChange],
  );
  return (
    <textarea
      {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
      rows={rows}
      value={current}
      placeholder={resolvePlaceholder(value, editLocale, defaultLocale, placeholder)}
      onChange={handle}
    />
  );
}

type ArrayBase = {
  value: Localized<string[]> | undefined;
  editLocale: LocaleCode;
  defaultLocale: LocaleCode;
  onChange: (next: Localized<string[]>) => void;
  placeholder?: string;
  className?: string;
};

export function LocalizedArrayInput(props: ArrayBase) {
  const { value, editLocale, defaultLocale, onChange, placeholder, className } = props;
  const items = value?.[editLocale] ?? [];
  const setItems = (next: string[]) =>
    onChange({ ...(value ?? {}), [editLocale]: next });

  return (
    <div className={className}>
      {items.map((item, i) => (
        <input
          key={i}
          value={item}
          placeholder={resolvePlaceholder(
            value as Localized<string> | undefined,
            editLocale,
            defaultLocale,
            placeholder,
          )}
          onChange={(e) => {
            const next = [...items];
            next[i] = e.target.value;
            setItems(next);
          }}
        />
      ))}
      <button type="button" onClick={() => setItems([...items, ""])}>+ Add</button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- localized-input.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/localized-input.tsx apps/dashboard/src/components/funnel-builder/__tests__/localized-input.test.tsx
git commit -m "feat(funnel-builder): add LocalizedInput / Textarea / ArrayInput"
```

---

## Task 9: `<LocaleSwitcher>` component (TDD)

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/locale-switcher.tsx`
- Create: `apps/dashboard/src/components/funnel-builder/__tests__/locale-switcher.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/funnel-builder/__tests__/locale-switcher.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LocaleSwitcher } from "../locale-switcher";

describe("<LocaleSwitcher>", () => {
  const base = {
    defaultLocale: "en",
    locales: ["en", "tr"],
    editLocale: "en",
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
  };

  it("lists every locale and marks the default", () => {
    render(<LocaleSwitcher {...base} />);
    fireEvent.click(screen.getByRole("button", { name: /en/i }));
    expect(screen.getByText(/tr/i)).toBeInTheDocument();
    expect(screen.getByText(/default/i)).toBeInTheDocument();
  });

  it("calls onSelect when a non-edit locale is clicked", () => {
    const onSelect = vi.fn();
    render(<LocaleSwitcher {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /en/i }));
    fireEvent.click(screen.getByText("tr"));
    expect(onSelect).toHaveBeenCalledWith("tr");
  });

  it("calls onAdd with a typed locale code", () => {
    const onAdd = vi.fn();
    render(<LocaleSwitcher {...base} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: /en/i }));
    fireEvent.click(screen.getByRole("button", { name: /add language/i }));
    fireEvent.change(screen.getByPlaceholderText(/bcp47/i), { target: { value: "de" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(onAdd).toHaveBeenCalledWith("de");
  });

  it("disables remove on the default locale", () => {
    render(<LocaleSwitcher {...base} editLocale="en" />);
    fireEvent.click(screen.getByRole("button", { name: /en/i }));
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("calls onRemove for a non-default locale", () => {
    const onRemove = vi.fn();
    render(<LocaleSwitcher {...base} editLocale="tr" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /tr/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove tr/i }));
    expect(onRemove).toHaveBeenCalledWith("tr");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard test -- locale-switcher.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `locale-switcher.tsx`**

Create `apps/dashboard/src/components/funnel-builder/locale-switcher.tsx`:

```tsx
import { useState } from "react";
import type { LocaleCode } from "@rovenue/shared/i18n";

interface Props {
  defaultLocale: LocaleCode;
  locales: readonly LocaleCode[];
  editLocale: LocaleCode;
  onSelect: (locale: LocaleCode) => void;
  onAdd: (locale: LocaleCode) => void;
  onRemove: (locale: LocaleCode) => void;
}

const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4}){0,2}$/;

export function LocaleSwitcher(props: Props) {
  const { defaultLocale, locales, editLocale, onSelect, onAdd, onRemove } = props;
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submitAdd = () => {
    const code = draft.trim();
    if (!BCP47.test(code)) return;
    if (locales.includes(code)) {
      setAdding(false);
      setDraft("");
      return;
    }
    onAdd(code);
    setAdding(false);
    setDraft("");
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
        aria-label={editLocale}
      >
        <span>{editLocale}</span>
        <span aria-hidden>▾</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-56 rounded-md border bg-white p-1 shadow-md">
          {locales.map((loc) => (
            <div key={loc} className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-100">
              <button
                type="button"
                className="flex-1 text-left"
                onClick={() => {
                  onSelect(loc);
                  setOpen(false);
                }}
              >
                <span>{loc}</span>
                {loc === defaultLocale && <span className="ml-2 text-[10px] uppercase opacity-60">default</span>}
              </button>
              {loc !== defaultLocale && (
                <button
                  type="button"
                  aria-label={`Remove ${loc}`}
                  onClick={() => {
                    onRemove(loc);
                    setOpen(false);
                  }}
                  className="text-xs opacity-60 hover:opacity-100"
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          <div className="mt-1 border-t pt-1">
            {adding ? (
              <div className="flex gap-1 px-2 py-1">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="BCP47 (e.g. tr, pt-BR)"
                  className="flex-1 rounded border px-1 py-0.5 text-xs"
                />
                <button type="button" onClick={submitAdd} className="rounded bg-black px-2 py-0.5 text-xs text-white">
                  Add
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="w-full rounded px-2 py-1 text-left text-sm hover:bg-gray-100"
              >
                + Add language
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- locale-switcher.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/locale-switcher.tsx apps/dashboard/src/components/funnel-builder/__tests__/locale-switcher.test.tsx
git commit -m "feat(funnel-builder): add LocaleSwitcher"
```

---

## Task 10: View-model — `editLocale`, `addLocale`, `removeLocale`, normalize on load

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts`
- Modify: `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.test.ts` (existing)

This task wires the data model. UI mounting comes in Task 11.

- [ ] **Step 1: Add imports + state**

In `funnel-draft.vm.ts`, add to the existing imports near the top:

```ts
import { mapFunnelLocales, normalizeFunnel } from "../i18n";
import type { LocaleCode } from "@rovenue/shared/i18n";
```

Inside the `FunnelDraftViewModel` class, add the new state right after the existing `@state name = ""` block:

```ts
  @state editLocale: LocaleCode = "en";
  @state defaultLocale: LocaleCode = "en";
  @state locales: LocaleCode[] = ["en"];
```

- [ ] **Step 2: Normalize on load**

Locate the existing load handler that sets `this.funnel = …` after fetching the funnel (search for `this.funnel =` inside an `async` method — typically the `onInit` body). Wrap the assignment so legacy data is lifted:

```ts
const detail = await FunnelApi.get(this.funnelId);
const normalized = normalizeFunnel(detail as unknown as Funnel) as unknown as FunnelDetailDto;
this.funnel = normalized;
this.defaultLocale = normalized.defaultLocale ?? "en";
this.locales = (normalized.locales as LocaleCode[]) ?? ["en"];
this.editLocale = this.defaultLocale;
```

If the existing code mutates `this.funnel` from multiple paths (save round-trip, retry), apply the same normalize at each site. Search `this.funnel =` inside the file and apply.

- [ ] **Step 3: Add the locale-management actions**

Append three new methods to the class body:

```ts
  @trigger setEditLocale(locale: LocaleCode) {
    if (!this.locales.includes(locale)) return;
    this.editLocale = locale;
  }

  @trigger addLocale(locale: LocaleCode) {
    if (this.locales.includes(locale)) return;
    this.locales = [...this.locales, locale];
    if (this.funnel) {
      // Persist on the next save; nothing to mutate on existing fields.
      (this.funnel as unknown as Funnel).locales = this.locales;
    }
    this.editLocale = locale;
  }

  @trigger removeLocale(locale: LocaleCode) {
    if (locale === this.defaultLocale) return;
    if (!this.locales.includes(locale)) return;
    this.locales = this.locales.filter((l) => l !== locale);
    if (this.funnel) {
      const next = mapFunnelLocales(this.funnel as unknown as Funnel, (loc) => {
        const copy: Record<string, unknown> = { ...loc };
        delete copy[locale];
        return copy as typeof loc;
      });
      (next as unknown as { locales: LocaleCode[] }).locales = this.locales;
      this.funnel = next as unknown as FunnelDetailDto;
    }
    if (this.editLocale === locale) this.editLocale = this.defaultLocale;
  }
```

- [ ] **Step 4: Update both `toEvalPage(...)` call sites**

The signature changed in Task 4 from `toEvalPage(p, rules?, defaultNext?)` to `toEvalPage(p, locale, rules?, defaultNext?)`. Find every caller:

```bash
grep -n "toEvalPage(" apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts apps/dashboard/src/components/funnel-builder/vm/funnel-preview.vm.ts
```

Expected: 1 hit in `funnel-draft.vm.ts` (~line 429) and 2 hits in `funnel-preview.vm.ts` (~lines 57, 61).

In `funnel-draft.vm.ts`, change:

```ts
toEvalPage(p, this.rules[p.id] ?? [], this.defaultNext[p.id] ?? undefined),
```

to:

```ts
toEvalPage(p, this.editLocale, this.rules[p.id] ?? [], this.defaultNext[p.id] ?? undefined),
```

In `funnel-preview.vm.ts`, the VM doesn't own `editLocale` directly — derive it from the draft VM via DI (search the file for `@inject` of `FunnelDraftViewModel` or similar) and pass `this.draft.editLocale`. If preview VM has no handle to draft, plumb a new prop `editLocale: LocaleCode` through `Props` (mirroring `rules` / `defaultNext`) and have the shell pass `vm.editLocale` into the preview-VM construction.

Add the import at the top of `funnel-preview.vm.ts` if needed:

```ts
import type { LocaleCode } from "@rovenue/shared/i18n";
```

Update both call sites the same way as `funnel-draft.vm.ts`.

- [ ] **Step 5: Persist `defaultLocale` + `locales` on save**

Find the save handler (search for `FunnelApi.save` or `FunnelApi.update` calls). Make sure the payload includes `defaultLocale` and `locales`:

```ts
await FunnelApi.update(this.projectId, this.funnelId, {
  // …existing fields…
  defaultLocale: this.defaultLocale,
  locales: this.locales,
});
```

If the API doesn't accept these fields yet, they round-trip silently through the JSONB column; add the fields to whatever request type the dashboard sends and accept that the backend will echo them.

- [ ] **Step 6: Extend the existing VM test**

Open `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.test.ts` and append a new test block. Match whatever fixture pattern already exists in that file; the assertions to add:

```ts
import { describe, expect, it } from "vitest";
// reuse whatever harness the existing tests use

describe("FunnelDraftViewModel — locale actions", () => {
  it("addLocale appends to locales and switches editLocale", () => {
    const vm = makeVm();           // existing helper, or inline a new instance
    vm.addLocale("tr");
    expect(vm.locales).toEqual(["en", "tr"]);
    expect(vm.editLocale).toBe("tr");
  });

  it("removeLocale strips the key from every Localized field", () => {
    const vm = makeVm();
    vm.addLocale("tr");
    // hydrate a fake page
    (vm as any).funnel = {
      ...((vm as any).funnel ?? {}),
      pages: [{ id: "p1", type: "welcome", title: { en: "Hi", tr: "Selam" }, options: [] }],
      locales: ["en", "tr"],
      defaultLocale: "en",
    };
    vm.removeLocale("tr");
    expect((vm as any).funnel.pages[0].title).toEqual({ en: "Hi" });
    expect(vm.locales).toEqual(["en"]);
    expect(vm.editLocale).toBe("en");
  });

  it("removeLocale is a no-op on the default locale", () => {
    const vm = makeVm();
    vm.removeLocale("en");
    expect(vm.locales).toContain("en");
  });
});
```

If the file has no `makeVm` helper, instantiate directly: `const vm = new FunnelDraftViewModel({ projectId: "p", funnelId: "f" });` and feed in a fake `funnel` after construction.

- [ ] **Step 7: Run the VM tests**

Run: `pnpm --filter @rovenue/dashboard test -- funnel-draft.vm.test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts apps/dashboard/src/components/funnel-builder/vm/funnel-preview.vm.ts apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.test.ts
git commit -m "feat(funnel-builder): VM editLocale + addLocale/removeLocale + load-time normalize"
```

---

## Task 11: Mount `<LocaleSwitcher>` in the builder shell + swap properties-panel inputs

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/builder-shell.tsx`
- Modify: `apps/dashboard/src/components/funnel-builder/properties-panel.tsx`

- [ ] **Step 1: Mount the switcher in `builder-shell.tsx`**

Find the header region of `builder-shell.tsx` (the JSX block that renders the existing tab bar — the spec referenced `builder-shell.tsx:109`'s "absolute left-1/2" centered container). Add this import block at the top:

```tsx
import { LocaleSwitcher } from "./locale-switcher";
```

Inside the header, immediately to the right of the existing tabs (or in a new flex-end slot), render:

```tsx
<LocaleSwitcher
  defaultLocale={vm.defaultLocale}
  locales={vm.locales}
  editLocale={vm.editLocale}
  onSelect={(l) => vm.setEditLocale(l)}
  onAdd={(l) => vm.addLocale(l)}
  onRemove={(l) => vm.removeLocale(l)}
/>
```

If the shell uses a different DI binding for the view-model (search for `useInstance(FunnelDraftViewModel)` or similar), use that hook to get `vm`.

- [ ] **Step 2: Pass `editLocale` + `defaultLocale` into `<PropertiesPanel>`**

Wherever `<PropertiesPanel page={…} onChange={…} />` is rendered in the shell, add:

```tsx
<PropertiesPanel
  page={page}
  onChange={onChange}
  editLocale={vm.editLocale}
  defaultLocale={vm.defaultLocale}
/>
```

- [ ] **Step 3: Add the new props to `PropertiesPanel`**

At the top of `properties-panel.tsx`, add:

```tsx
import { LocalizedInput, LocalizedTextarea, LocalizedArrayInput } from "./localized-input";
import type { LocaleCode } from "@rovenue/shared/i18n";
```

Update the component's props type:

```ts
interface PropertiesPanelProps {
  page: Page;
  onChange: (patch: Partial<Page>) => void;
  editLocale: LocaleCode;
  defaultLocale: LocaleCode;
}
```

Destructure `editLocale` and `defaultLocale` in the function body.

- [ ] **Step 4: Swap every translatable input**

For each occurrence of `<input value={page.<field> ?? ""} onChange={(e) => set({ <field>: e.target.value })} />` where `<field>` is one of:

```
title, subtitle, body, cta, headline, placeholder, suffix, agreementLabel
```

…replace with (use `LocalizedTextarea` when the original was a `<textarea>`):

```tsx
<LocalizedInput
  value={page.title}
  editLocale={editLocale}
  defaultLocale={defaultLocale}
  onChange={(next) => set({ title: next })}
/>
```

For `benefits`, `features`, `steps` — the original code maps over the array and renders one `<input>` per entry. Replace the whole array-input cluster with:

```tsx
<LocalizedArrayInput
  value={page.benefits}
  editLocale={editLocale}
  defaultLocale={defaultLocale}
  onChange={(next) => set({ benefits: next })}
/>
```

The existing `steps` field shows a single `<textarea>` whose lines split into the array. Keep that UX by binding the textarea via `LocalizedTextarea` to a derived join/split — or simpler: switch `steps` to `LocalizedArrayInput` and accept a small UX change (one row per step). This plan picks the latter to stay consistent.

For `options[].label` — the panel renders an input per option. Update the change handler to write into the localized label:

```tsx
<LocalizedInput
  value={o.label}
  editLocale={editLocale}
  defaultLocale={defaultLocale}
  onChange={(next) => {
    const opts = [...(page.options ?? [])];
    opts[i] = { ...opts[i], label: next };
    set({ options: opts });
  }}
/>
```

- [ ] **Step 5: Smoke-test by running the dashboard**

Run: `pnpm --filter @rovenue/dashboard dev`

In the browser:
1. Open any draft funnel
2. Confirm the LocaleSwitcher appears in the header showing "en"
3. Click "+ Add language" → enter "tr" → press Add
4. Editor switches to `tr`; properties panel inputs show empty with "Hi" (or whatever the EN value is) greyed as placeholder
5. Type something in `tr`; switch back to `en`; the EN value is preserved

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: only errors in `page-preview.tsx`, `funnel-runner.tsx`, `validation-drawer.tsx` (handled by later tasks).

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/builder-shell.tsx apps/dashboard/src/components/funnel-builder/properties-panel.tsx
git commit -m "feat(funnel-builder): mount LocaleSwitcher + Localized inputs in properties panel"
```

---

## Task 12: Update `page-preview.tsx` to consume a resolved view

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/page-preview.tsx`

- [ ] **Step 1: Add the resolved-page bridge**

At the top of `page-preview.tsx`, replace the existing `import type { Page } from "./types"` line with:

```tsx
import type { LocaleCode } from "@rovenue/shared/i18n";
import { resolvePage, type ResolvedPage } from "./i18n";
import type { Page, Theme } from "./types";
```

- [ ] **Step 2: Add locale props and resolve at the top of the component**

Update the component signature. Where the current code reads `interface PagePreviewProps { page: Page; theme: Theme; … }`, change to:

```tsx
interface PagePreviewProps {
  page: Page;
  theme: Theme;
  locale: LocaleCode;
  defaultLocale: LocaleCode;
  // …all other existing fields unchanged…
}
```

At the very top of the function body, before any `page.title || …` reads:

```tsx
const resolved: ResolvedPage = useMemo(
  () => resolvePage(page, locale, defaultLocale),
  [page, locale, defaultLocale],
);
```

Add `useMemo` to the existing React import if not already present.

- [ ] **Step 3: Swap every read site**

Replace every `page.title`, `page.subtitle`, `page.body`, `page.cta`, `page.headline`, `page.placeholder`, `page.suffix`, `page.agreementLabel`, `page.benefits`, `page.features`, `page.steps`, and `o.label` (where `o` iterates `page.options`) with the matching `resolved.*` access — e.g. `resolved.title`, `resolved.options?.[i].label`.

Use a single global find-replace: in the file, scan for `page\.\(title|subtitle|body|cta|headline|placeholder|suffix|agreementLabel|benefits|features|steps\)` and swap the prefix. Check each iteration over `page.options`: replace `o.label` (within the map body) with `o.label` of `resolved.options` — i.e. switch the iteration source to `resolved.options ?? []` instead of `page.options ?? []`.

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: errors should now be confined to `funnel-runner.tsx` (Task 13) and any remaining call site that mounts `<PagePreview>` without the new `locale` props.

For the builder's other `<PagePreview>` mount (typically `canvas-editor.tsx` and `thumb-rail.tsx`), pass:

```tsx
<PagePreview page={page} theme={theme} locale={vm.editLocale} defaultLocale={vm.defaultLocale} {…} />
```

Search for `<PagePreview` and update every call site.

- [ ] **Step 5: Smoke-test in the browser**

Re-run the dev server (Task 11 Step 5) and confirm preview updates when switching languages.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/page-preview.tsx apps/dashboard/src/components/funnel-builder/canvas-editor.tsx apps/dashboard/src/components/funnel-builder/thumb-rail.tsx
git commit -m "feat(funnel-builder): PagePreview consumes ResolvedPage via locale props"
```

---

## Task 13: Hook the runner up to `useRunnerLocale` + system strings

**Files:**
- Modify: `apps/dashboard/src/runner/funnel-runner.tsx`

The runner currently reads `state.config.pages[i].cta` (and similar) directly. We route those through `pick()` and the system pack.

- [ ] **Step 1: Add imports**

At the top of `funnel-runner.tsx`:

```tsx
import { pick, type LocaleCode } from "@rovenue/shared/i18n";
import { getSystemStrings } from "./locales";
import { useRunnerLocale } from "./use-runner-locale";
```

- [ ] **Step 2: Compute locale + strings inside the component**

Right after `const currentPage = useMemo(…)` near the top of `FunnelRunner`, add:

```tsx
const localeConfig = useMemo(
  () => ({
    defaultLocale: (state?.config as { defaultLocale?: string } | undefined)?.defaultLocale ?? "en",
    locales:
      ((state?.config as { locales?: string[] } | undefined)?.locales as LocaleCode[]) ?? ["en"],
  }),
  [state?.config],
);
const locale = useRunnerLocale(localeConfig);
const sys = getSystemStrings(locale);
```

- [ ] **Step 3: Resolve CTA fallbacks via the system pack**

The existing fallback chain reads (paraphrased):

```ts
return page.cta || "Get started";
return page.cta || "Open app";
return page.cta || "Continue";
```

Update them to:

```ts
return pick(page.cta, locale, [localeConfig.defaultLocale]) || sys.cta.getStarted;
return pick(page.cta, locale, [localeConfig.defaultLocale]) || sys.cta.openApp;
return pick(page.cta, locale, [localeConfig.defaultLocale]) || sys.cta.continue;
```

- [ ] **Step 4: Pass locale into `<PagePreview>`**

Find `<PagePreview page={currentPage} … />` and add the locale props:

```tsx
<PagePreview
  page={currentPage}
  // …existing props…
  locale={locale}
  defaultLocale={localeConfig.defaultLocale}
/>
```

- [ ] **Step 5: Verify TS now type-checks**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Smoke-test**

With the dev server running, open a published funnel at `http://localhost:5173/f/<slug>?lng=tr`. Confirm a `tr`-authored title renders. Try `?lng=zz` and confirm the default locale renders.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/runner/funnel-runner.tsx
git commit -m "feat(runner): resolve locale + system strings + pass to PagePreview"
```

---

## Task 14: Validation drawer — surface missing translations

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/validation-drawer.tsx`

- [ ] **Step 1: Add the missing-translation collector**

At the top of `validation-drawer.tsx`, add:

```tsx
import { isLocalized, type LocaleCode } from "@rovenue/shared/i18n";
import { LOCALIZED_PAGE_FIELDS, type Funnel, type Page } from "./types";
```

Add a helper above the component:

```ts
type MissingTranslation = { locale: LocaleCode; pageId: string; field: string };

export function collectMissingTranslations(funnel: Funnel): MissingTranslation[] {
  const out: MissingTranslation[] = [];
  const nonDefault = funnel.locales.filter((l) => l !== funnel.defaultLocale);
  if (nonDefault.length === 0) return out;

  for (const page of funnel.pages) {
    for (const field of LOCALIZED_PAGE_FIELDS) {
      const v = page[field];
      if (!isLocalized(v)) continue;
      const map = v as Record<string, unknown>;
      const def = map[funnel.defaultLocale];
      if (!def) continue;
      for (const loc of nonDefault) {
        const val = map[loc];
        if (val === undefined || val === "" || (Array.isArray(val) && val.length === 0)) {
          out.push({ locale: loc, pageId: page.id, field: String(field) });
        }
      }
    }
    if (page.options) {
      page.options.forEach((o, idx) => {
        if (!isLocalized(o.label)) return;
        const map = o.label as Record<string, string>;
        if (!map[funnel.defaultLocale]) return;
        for (const loc of nonDefault) {
          if (!map[loc]) out.push({ locale: loc, pageId: page.id, field: `options[${idx}].label` });
        }
      });
    }
  }
  return out;
}
```

- [ ] **Step 2: Render a "Missing translations" section**

Inside the existing drawer JSX, after whatever group renders structural validation issues, add:

```tsx
{(() => {
  const missing = collectMissingTranslations(funnel);
  if (missing.length === 0) return null;
  const byLocale = new Map<LocaleCode, MissingTranslation[]>();
  for (const m of missing) {
    if (!byLocale.has(m.locale)) byLocale.set(m.locale, []);
    byLocale.get(m.locale)!.push(m);
  }
  return (
    <section>
      <header className="px-3 py-2 text-xs font-semibold uppercase opacity-60">
        Missing translations
      </header>
      {[...byLocale.entries()].map(([loc, items]) => (
        <div key={loc} className="px-3 py-1 text-sm">
          <span className="font-medium">{loc}</span> · {items.length} fields
          <ul className="ml-2 list-disc">
            {items.slice(0, 8).map((m, i) => (
              <li key={i} className="text-xs opacity-70">
                {m.pageId} · {m.field}
              </li>
            ))}
            {items.length > 8 && <li className="text-xs opacity-60">+{items.length - 8} more…</li>}
          </ul>
        </div>
      ))}
    </section>
  );
})()}
```

- [ ] **Step 3: Add a quick collector test**

Create `apps/dashboard/src/components/funnel-builder/__tests__/validation-drawer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collectMissingTranslations } from "../validation-drawer";
import type { Funnel } from "../types";

function f(overrides: Partial<Funnel> = {}): Funnel {
  return {
    id: "f", name: "F", slug: "f", status: "draft", version: 1,
    draftDiffersFromPublished: false, theme: {} as Funnel["theme"],
    settings: {} as Funnel["settings"], pages: [], rules: {}, default_next: {},
    defaultLocale: "en", locales: ["en", "tr"], ...overrides,
  };
}

describe("collectMissingTranslations", () => {
  it("flags fields that have default but not non-default locale", () => {
    const out = collectMissingTranslations(f({
      pages: [{ id: "p1", type: "welcome", title: { en: "Hi" } }],
    }));
    expect(out).toEqual([{ locale: "tr", pageId: "p1", field: "title" }]);
  });

  it("does not flag when only non-default has a value (nothing to translate)", () => {
    const out = collectMissingTranslations(f({
      pages: [{ id: "p1", type: "welcome", title: { tr: "Selam" } }],
    }));
    expect(out).toEqual([]);
  });

  it("flags missing option labels", () => {
    const out = collectMissingTranslations(f({
      pages: [{
        id: "p1", type: "single_choice",
        options: [{ label: { en: "Yes" }, value: "y" }],
      }],
    }));
    expect(out).toEqual([{ locale: "tr", pageId: "p1", field: "options[0].label" }]);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @rovenue/dashboard test -- validation-drawer.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/validation-drawer.tsx apps/dashboard/src/components/funnel-builder/__tests__/validation-drawer.test.ts
git commit -m "feat(funnel-builder): surface missing-translation warnings in validation drawer"
```

---

## Task 15: End-to-end runner test

**Files:**
- Create: `apps/dashboard/src/runner/__tests__/funnel-runner.locale.test.tsx`

- [ ] **Step 1: Write the test**

Create `apps/dashboard/src/runner/__tests__/funnel-runner.locale.test.tsx`:

```tsx
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Mock the runner API so we control the published config + session.
vi.mock("../runner-api", () => ({
  getPublishedFunnel: vi.fn(),
  startSession: vi.fn(),
  advanceSession: vi.fn(),
  claimToken: vi.fn(),
  RunnerApiError: class extends Error { code = "ERR"; },
}));

import { FunnelRunner } from "../funnel-runner";
import * as api from "../runner-api";

const baseConfig = {
  slug: "demo",
  defaultLocale: "en",
  locales: ["en", "tr"],
  pages: [
    {
      id: "p1",
      type: "welcome",
      title: { en: "Hello", tr: "Merhaba" },
      cta: { en: "Continue", tr: "Devam" },
    },
  ],
};

beforeEach(() => {
  vi.mocked(api.getPublishedFunnel).mockResolvedValue(baseConfig as never);
  vi.mocked(api.startSession).mockResolvedValue({ session_id: "s1", first_page_id: "p1" } as never);
});

describe("FunnelRunner locale", () => {
  it("renders the TR title when ?lng=tr", async () => {
    window.history.replaceState({}, "", "/?lng=tr");
    render(<FunnelRunner slug="demo" />);
    await waitFor(() => expect(screen.getByText("Merhaba")).toBeInTheDocument());
  });

  it("falls back to defaultLocale when ?lng= isn't in funnel.locales", async () => {
    window.history.replaceState({}, "", "/?lng=zz");
    render(<FunnelRunner slug="demo" />);
    await waitFor(() => expect(screen.getByText("Hello")).toBeInTheDocument());
  });

  it("resolves region fallback (pt-BR → pt) when only the primary tag is authored", async () => {
    vi.mocked(api.getPublishedFunnel).mockResolvedValue({
      ...baseConfig,
      locales: ["en", "pt"],
      pages: [{ id: "p1", type: "welcome", title: { en: "Hello", pt: "Olá" } }],
    } as never);
    window.history.replaceState({}, "", "/?lng=pt-BR");
    render(<FunnelRunner slug="demo" />);
    await waitFor(() => expect(screen.getByText("Olá")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm --filter @rovenue/dashboard test -- funnel-runner.locale.test`
Expected: PASS.

If the runner imports any other API that isn't mocked above (e.g. analytics ping on mount), add a stub to the `vi.mock` factory.

- [ ] **Step 3: Run the full dashboard test suite to catch regressions**

Run: `pnpm --filter @rovenue/dashboard test`
Expected: all tests pass.

- [ ] **Step 4: Final commit**

```bash
git add apps/dashboard/src/runner/__tests__/funnel-runner.locale.test.tsx
git commit -m "test(runner): e2e locale resolution + region fallback + allowlist"
```

---

## Verification checklist (after Task 15)

- [ ] `pnpm --filter @rovenue/shared test` — green
- [ ] `pnpm --filter @rovenue/dashboard test` — green
- [ ] `pnpm --filter @rovenue/dashboard exec tsc --noEmit` — clean
- [ ] `pnpm build` — green from repo root
- [ ] Manual smoke: open a draft funnel, add `tr` via the switcher, author titles in TR, publish, open public URL with `?lng=tr` and confirm rendering
