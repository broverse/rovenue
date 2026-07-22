import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Star, X } from "lucide-react";
import type { PaywallRemoteConfig } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import {
  addLocale,
  isValidLocaleCode,
  normalizeLocaleCode,
  parseLocaleJson,
  removeLocale,
  setDefaultLocale,
  setLocaleValue,
} from "./remote-config-utils";

type Props = {
  value: PaywallRemoteConfig;
  onChange: (next: PaywallRemoteConfig) => void;
  /** Fires whenever any locale's textarea holds unparsed/invalid JSON,
   *  so the parent form can hold off on submit. */
  onValidityChange?: (valid: boolean) => void;
};

function stringifyLocale(config: PaywallRemoteConfig, locale: string): string {
  return JSON.stringify(config.locales[locale] ?? {}, null, 2);
}

/**
 * Locale tabs (add/remove + default-locale marker) over a per-locale JSON
 * textarea. Each locale keeps its own draft text buffer so an in-progress
 * (invalid) edit in one locale survives switching tabs without being lost
 * or silently discarded — it's only committed into `value` once it parses
 * as a JSON object, matching the API's `remoteConfigSchema`.
 */
export function RemoteConfigEditor({ value, onChange, onValidityChange }: Props) {
  const { t } = useTranslation();
  const addInputId = useId();

  const localeCodes = Object.keys(value.locales).sort();
  const [activeLocale, setActiveLocale] = useState(value.defaultLocale);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(localeCodes.map((l) => [l, stringifyLocale(value, l)])),
  );
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [newLocale, setNewLocale] = useState("");
  const [newLocaleError, setNewLocaleError] = useState<string | null>(null);

  // Keep the draft buffer in sync when locales are added/removed, or when
  // a locale's committed value changes from outside this component (e.g.
  // switching between paywalls in the same dialog instance).
  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const l of localeCodes) {
        next[l] = l in prev ? prev[l]! : stringifyLocale(value, l);
      }
      return next;
    });
    setErrors((prev) => {
      const next: Record<string, string | null> = {};
      for (const l of localeCodes) next[l] = prev[l] ?? null;
      return next;
    });
    if (!localeCodes.includes(activeLocale)) {
      setActiveLocale(value.defaultLocale);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.locales, value.defaultLocale]);

  useEffect(() => {
    const hasError = Object.values(errors).some((e) => e != null);
    onValidityChange?.(!hasError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errors]);

  const handleTextChange = (locale: string, text: string) => {
    setDrafts((prev) => ({ ...prev, [locale]: text }));
    const parsed = parseLocaleJson(text);
    if (parsed.ok) {
      setErrors((prev) => ({ ...prev, [locale]: null }));
      onChange(setLocaleValue(value, locale, parsed.value!));
    } else {
      setErrors((prev) => ({ ...prev, [locale]: parsed.error ?? "Invalid JSON" }));
    }
  };

  const handleAddLocale = () => {
    const code = normalizeLocaleCode(newLocale);
    if (!code) return;
    if (!isValidLocaleCode(code)) {
      setNewLocaleError(
        t("paywalls.remoteConfig.locale.invalid", "Use a locale code like en, en-US or pt-BR."),
      );
      return;
    }
    if (Object.prototype.hasOwnProperty.call(value.locales, code)) {
      setNewLocaleError(
        t("paywalls.remoteConfig.locale.duplicate", "This locale is already added."),
      );
      return;
    }
    onChange(addLocale(value, code));
    setActiveLocale(code);
    setNewLocale("");
    setNewLocaleError(null);
  };

  const handleRemoveLocale = (locale: string) => {
    if (localeCodes.length <= 1) return;
    onChange(removeLocale(value, locale));
  };

  const activeError = errors[activeLocale] ?? null;

  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="tablist"
        aria-label={t("paywalls.remoteConfig.tabsLabel", "Locales")}
        className="flex flex-wrap items-center gap-1.5"
      >
        {localeCodes.map((locale) => {
          const active = locale === activeLocale;
          const isDefault = locale === value.defaultLocale;
          const hasError = errors[locale] != null;
          return (
            <div
              key={locale}
              className={cn(
                "group inline-flex items-center gap-1 rounded-md border px-2 py-1",
                active
                  ? "border-rv-accent-500/40 bg-rv-accent-500/10"
                  : "border-rv-divider bg-rv-c2 hover:bg-rv-c3",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveLocale(locale)}
                className={cn(
                  "cursor-pointer font-rv-mono text-[11px] uppercase",
                  active ? "text-rv-accent-400" : "text-rv-mute-700",
                  hasError && "text-rv-danger",
                )}
              >
                {locale}
              </button>
              {isDefault ? (
                <Star
                  size={11}
                  className="text-rv-accent-400"
                  aria-label={t("paywalls.remoteConfig.locale.default", "Default locale")}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onChange(setDefaultLocale(value, locale))}
                  aria-label={t(
                    "paywalls.remoteConfig.locale.makeDefault",
                    "Make {{locale}} the default locale",
                    { locale },
                  )}
                  title={t(
                    "paywalls.remoteConfig.locale.makeDefault",
                    "Make {{locale}} the default locale",
                    { locale },
                  )}
                  className="text-rv-mute-500 opacity-0 transition hover:text-rv-accent-400 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Star size={11} />
                </button>
              )}
              {localeCodes.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleRemoveLocale(locale)}
                  aria-label={t("paywalls.remoteConfig.locale.remove", "Remove {{locale}}", {
                    locale,
                  })}
                  className="text-rv-mute-500 transition hover:text-rv-danger"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}

        <div className="flex items-center gap-1">
          <label htmlFor={addInputId} className="sr-only">
            {t("paywalls.remoteConfig.locale.addLabel", "Add locale")}
          </label>
          <input
            id={addInputId}
            value={newLocale}
            onChange={(e) => {
              setNewLocale(e.target.value);
              setNewLocaleError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddLocale();
              }
            }}
            placeholder={t("paywalls.remoteConfig.locale.addPlaceholder", "e.g. tr")}
            spellCheck={false}
            autoComplete="off"
            className="h-[26px] w-[76px] rounded-md border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-foreground placeholder:text-rv-mute-500 focus:border-rv-accent-500 focus:outline-none focus:ring-2 focus:ring-rv-accent-500/30"
          />
          <Button type="button" variant="flat" size="icon" onClick={handleAddLocale}>
            <Plus size={12} />
          </Button>
        </div>
      </div>

      {newLocaleError && <p className="text-[11px] text-rv-danger">{newLocaleError}</p>}

      <Textarea
        value={drafts[activeLocale] ?? "{}"}
        onChange={(e) => handleTextChange(activeLocale, e.target.value)}
        rows={12}
        spellCheck={false}
        aria-invalid={activeError != null}
        className={cn(
          "font-rv-mono text-[12px]",
          activeError && "border-rv-danger focus:border-rv-danger focus:ring-rv-danger/30",
        )}
      />
      {activeError ? (
        <p className="text-[11px] text-rv-danger">{activeError}</p>
      ) : (
        <p className="text-[11px] text-rv-mute-500">
          {t(
            "paywalls.remoteConfig.hint",
            "JSON object rendered by the SDK for this locale. Falls back to the default locale's keys when a key is missing.",
          )}
        </p>
      )}
    </div>
  );
}
