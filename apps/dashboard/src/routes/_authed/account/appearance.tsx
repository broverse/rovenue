import { useState } from "react";
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

function AppearancePage() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<(typeof THEMES)[number]["id"]>("dark");
  const [density, setDensity] = useState<Density>("comfortable");
  const [compactNumbers, setCompactNumbers] = useState(true);
  const [showCurrency, setShowCurrency] = useState(true);

  return (
    <AccountShell active="appearance">
      <AccountPageHeader
        title={t("account.appearance.title")}
        description={t("account.appearance.subtitle")}
      />

      <SectionCard title={t("account.appearance.theme.title")}>
        <div className="grid grid-cols-3 gap-2.5 max-[720px]:grid-cols-1">
          {THEMES.map((tm) => (
            <button
              type="button"
              key={tm.id}
              onClick={() => setTheme(tm.id)}
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
          onChange={setDensity}
          ariaLabel={t("account.appearance.density.title")}
        />
      </SectionCard>

      <SectionCard title={t("account.appearance.numbers.title")}>
        <AccountToggleRow
          title={t("account.appearance.numbers.compact.title")}
          description={t("account.appearance.numbers.compact.desc")}
          checked={compactNumbers}
          onChange={setCompactNumbers}
        />
        <AccountToggleRow
          title={t("account.appearance.numbers.currency.title")}
          description={t("account.appearance.numbers.currency.desc")}
          checked={showCurrency}
          onChange={setShowCurrency}
        />
      </SectionCard>
    </AccountShell>
  );
}
