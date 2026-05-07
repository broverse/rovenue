import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";

type Stat = {
  labelKey: string;
  value: string;
  tone?: "success";
};

type Props = {
  totalApps: number;
  connectedApps: number;
  events: string;
  successRate: string;
};

const heroStyle: CSSProperties = {
  background:
    "linear-gradient(135deg, color-mix(in srgb, var(--color-rv-accent-500) 12%, var(--color-rv-c1)), var(--color-rv-c1) 60%)",
};

export function AppsHero({ totalApps, connectedApps, events, successRate }: Props) {
  const { t } = useTranslation();
  const stats: ReadonlyArray<Stat> = [
    { labelKey: "apps", value: String(totalApps) },
    { labelKey: "connected", value: String(connectedApps), tone: "success" },
    { labelKey: "events", value: events },
    { labelKey: "successRate", value: successRate, tone: "success" },
  ];

  return (
    <div
      style={heroStyle}
      className="mb-4 grid grid-cols-1 items-center gap-6 rounded-[10px] border border-rv-divider px-7 py-6 lg:grid-cols-[1fr_auto]"
    >
      <div>
        <h2 className="text-[22px] font-semibold leading-snug text-foreground">
          {t("apps.hero.title")}
        </h2>
        <p className="mt-1.5 max-w-[620px] text-[13px] leading-[1.55] text-rv-mute-600">
          {t("apps.hero.description", { count: totalApps })}
        </p>
      </div>
      <div className="flex flex-wrap gap-7">
        {stats.map((stat) => (
          <div key={stat.labelKey}>
            <div
              className={
                stat.tone === "success"
                  ? "font-rv-mono text-[22px] font-medium leading-none text-rv-success"
                  : "font-rv-mono text-[22px] font-medium leading-none text-foreground"
              }
            >
              {stat.value}
            </div>
            <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
              {t(`apps.hero.stats.${stat.labelKey}`)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
