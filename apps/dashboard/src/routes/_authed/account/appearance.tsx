import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AccountPageHeader,
  AccountShell,
  AccountToggleRow,
  SectionCard,
} from "../../../components/account";
import { Segmented } from "../../../ui/segmented";
import { cn } from "../../../lib/cn";
import {
  useMyPreferences,
  useUpdatePreferences,
} from "../../../lib/hooks/useMyPreferences";

export const Route = createFileRoute("/_authed/account/appearance")({
  component: AppearancePage,
});

const THEMES = [
  { id: "dark" as const, preview: "#0F0F12" },
  { id: "light" as const, preview: "#FAFAFA" },
  { id: "system" as const, preview: "linear-gradient(135deg, #0F0F12 50%, #FAFAFA 50%)" },
];

const DENSITIES = ["compact", "comfortable", "spacious"] as const;
type Density = (typeof DENSITIES)[number];

type ThemeId = (typeof THEMES)[number]["id"];

function isThemeId(value: unknown): value is ThemeId {
  return value === "dark" || value === "light" || value === "system";
}

function isDensity(value: unknown): value is Density {
  return value === "compact" || value === "comfortable" || value === "spacious";
}

function AppearancePage() {
  const { t } = useTranslation();
  const { data: preferences } = useMyPreferences();
  const updatePrefs = useUpdatePreferences();

  const [theme, setTheme] = useState<ThemeId>("dark");
  const [density, setDensity] = useState<Density>("comfortable");
  const [compactNumbers, setCompactNumbers] = useState(true);
  const [showCurrency, setShowCurrency] = useState(true);

  // Hydrate from the API; bail on the field if it's missing or
  // shaped unexpectedly so a malformed blob can't soft-brick the
  // page.
  useEffect(() => {
    if (!preferences) return;
    const a = preferences.appearance as Record<string, unknown>;
    if (isThemeId(a.theme)) setTheme(a.theme);
    if (isDensity(a.density)) setDensity(a.density);
    if (typeof a.compactNumbers === "boolean") setCompactNumbers(a.compactNumbers);
    if (typeof a.showCurrency === "boolean") setShowCurrency(a.showCurrency);
  }, [preferences]);

  // Persist each control as it changes — the backend merges per
  // column so independent toggles don't race.
  const saveTheme = (next: ThemeId) => {
    setTheme(next);
    updatePrefs.mutate({ appearance: { theme: next } });
  };
  const saveDensity = (next: Density) => {
    setDensity(next);
    updatePrefs.mutate({ appearance: { density: next } });
  };
  const saveCompactNumbers = (next: boolean) => {
    setCompactNumbers(next);
    updatePrefs.mutate({ appearance: { compactNumbers: next } });
  };
  const saveShowCurrency = (next: boolean) => {
    setShowCurrency(next);
    updatePrefs.mutate({ appearance: { showCurrency: next } });
  };

  return (
    <AccountShell active="appearance">
      <AccountPageHeader
        title={t("account.appearance.title")}
        description={t("account.appearance.subtitle")}
      />

      <SectionCard title={t("account.appearance.theme.title")}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {THEMES.map((tm) => (
            <button
              type="button"
              key={tm.id}
              onClick={() => saveTheme(tm.id)}
              className={cn(
                "rounded-md border bg-rv-c2 p-3 text-left transition",
                theme === tm.id ? "border-rv-accent-500" : "border-rv-divider hover:border-rv-divider-strong",
              )}
            >
              <div
                className="mb-2 h-15 rounded border border-rv-divider"
                style={{ background: tm.preview }}
              />
              <div className="text-[13px] font-medium">
                {t(`account.appearance.theme.options.${tm.id}.name`)}
              </div>
              <div className="mt-0.5 text-[11px] text-rv-mute-500">
                {t(`account.appearance.theme.options.${tm.id}.desc`)}
              </div>
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title={t("account.appearance.density.title")}
        description={t("account.appearance.density.subtitle")}
      >
        <Segmented
          options={DENSITIES}
          value={density}
          onChange={saveDensity}
          ariaLabel={t("account.appearance.density.title")}
        />
      </SectionCard>

      <SectionCard title={t("account.appearance.numbers.title")}>
        <AccountToggleRow
          title={t("account.appearance.numbers.compact.title")}
          description={t("account.appearance.numbers.compact.desc")}
          checked={compactNumbers}
          onChange={saveCompactNumbers}
        />
        <AccountToggleRow
          title={t("account.appearance.numbers.currency.title")}
          description={t("account.appearance.numbers.currency.desc")}
          checked={showCurrency}
          onChange={saveShowCurrency}
        />
      </SectionCard>
    </AccountShell>
  );
}
