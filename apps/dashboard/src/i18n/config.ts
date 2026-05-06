import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";

/**
 * Single-source i18n bootstrap. We currently ship English only, but the
 * `resources` shape is keyed by language so additional locales can be
 * dropped in later without touching call sites.
 *
 * Imported once for its side effect from `main.tsx` before the router
 * renders so that `useTranslation()` is ready on first paint.
 */
void i18n.use(initReactI18next).init({
  resources: { en: { common: en } },
  lng: "en",
  fallbackLng: "en",
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
