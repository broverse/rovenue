import {
  liftToLocalized,
  mapLocalizedFields,
  pick,
  type LocaleCode,
  type Localized,
} from "@rovenue/shared/i18n";
import { LOCALIZED_PAGE_FIELDS, type Funnel, type Option, type Page } from "./types";

/** Lift legacy bare-string data into Localized<…> and guarantee defaultLocale/locales.
 *  Safe on every load and every save — idempotent. */
export function normalizeFunnel(funnel: Funnel): Funnel {
  const defaultLocale = funnel.defaultLocale || "en";
  const locales = funnel.locales?.length ? funnel.locales : [defaultLocale];

  const pages = funnel.pages.map((page) => {
    const lifted = liftPageFields(page, defaultLocale);
    if (!lifted.options) return lifted;
    return {
      ...lifted,
      options: lifted.options.map((o) => ({
        ...o,
        label:
          liftToLocalized(o.label as Localized<string> | string | undefined, defaultLocale) ??
          ({ [defaultLocale]: "" } as Localized<string>),
      })),
    };
  });

  return { ...funnel, defaultLocale, locales, pages };
}

/** Apply fn to every Localized<T> field on every page (and every Option.label).
 *  Used when adding/removing a language at funnel level. */
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
        return next === undefined
          ? { ...o, label: {} as Localized<string> }
          : { ...o, label: next as Localized<string> };
      }),
    };
  });
  return { ...funnel, pages };
}

/** Per-locale bare-value view of a Page. PagePreview/runner consume this. */
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

/** Flatten all Localized<T> fields and Option.label into bare values for the given locale. */
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

function liftPageFields(page: Page, defaultLocale: LocaleCode): Page {
  const next: Page = { ...page };
  for (const field of LOCALIZED_PAGE_FIELDS) {
    const v = next[field];
    if (v == null) continue;
    const lifted = liftToLocalized(v as Localized<unknown> | unknown, defaultLocale);
    if (lifted !== undefined) {
      next[field] = lifted as Page[typeof field];
    }
  }
  return next;
}

export type { Option };
