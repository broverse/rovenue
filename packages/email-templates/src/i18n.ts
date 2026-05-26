import i18next, {
  type i18n,
  type Resource,
  type TFunction,
} from "i18next";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Namespace = Record<string, string>;
type LocaleResources = Record<string, Namespace>;

const here = fileURLToPath(new URL(".", import.meta.url));
const localesDir = join(here, "..", "locales");

function loadResources(): Record<string, LocaleResources> {
  const resources: Record<string, LocaleResources> = {};
  for (const locale of readdirSync(localesDir)) {
    const ns: LocaleResources = {};
    for (const file of readdirSync(join(localesDir, locale))) {
      if (!file.endsWith(".json")) continue;
      const name = file.replace(/\.json$/, "");
      ns[name] = JSON.parse(
        readFileSync(join(localesDir, locale, file), "utf8"),
      ) as Namespace;
    }
    resources[locale] = ns;
  }
  return resources;
}

const resources = loadResources();
const supported = Object.keys(resources);

const instance: i18n = i18next.createInstance();
await instance.init({
  resources: Object.fromEntries(
    supported.map((l) => [l, resources[l] ?? {}]),
  ) as Resource,
  fallbackLng: "en",
  defaultNS: "common",
  ns: Array.from(
    new Set(supported.flatMap((l) => Object.keys(resources[l] ?? {}))),
  ),
  // Locale JSON uses flat dotted keys (e.g. "footer.unsubscribe"); disabling
  // keySeparator stops i18next from treating "." as a nesting path.
  keySeparator: false,
  nsSeparator: ":",
  interpolation: { escapeValue: false },
});

export function getT(locale: string): TFunction {
  return instance.getFixedT(supported.includes(locale) ? locale : "en");
}

export function supportedLocales(): readonly string[] {
  return supported;
}
