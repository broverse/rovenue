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

/** Locale codes we ship a pack for. Adding a "tr.json" + entry in PACKS is enough. */
export function availableSystemLocales(): LocaleCode[] {
  return Object.keys(PACKS);
}
