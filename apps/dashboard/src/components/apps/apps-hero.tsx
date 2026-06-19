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
};

const heroStyle: CSSProperties = {
  background:
    "linear-gradient(135deg, color-mix(in srgb, var(--color-rv-accent-500) 12%, var(--color-rv-c1)), var(--color-rv-c1) 60%)",
};

export function AppsHero({ totalApps, connectedApps }: Props) {
  const { t } = useTranslation();
  const stats: ReadonlyArray<Stat> = [
    { labelKey: "apps", value: String(totalApps) },
    { labelKey: "connected", value: String(connectedApps), tone: "success" },
  ];

  return (
    <div
      style={heroStyle}
      className="mb-4 grid grid-cols-1 items-center gap-5 rounded-[10px] border border-rv-divider px-4 py-5 sm:gap-6 sm:px-7 sm:py-6 lg:grid-cols-[1fr_auto]"
    >
      <div>
        <h2 className="text-[18px] font-semibold leading-snug text-foreground sm:text-[22px]">
          {t("apps.hero.title")}
        </h2>
        <p className="mt-1.5 max-w-[620px] text-[12.5px] leading-[1.55] text-rv-mute-600 sm:text-[13px]">
          {t("apps.hero.description", { count: totalApps })}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-7">
        {stats.map((stat) => (
          <div key={stat.labelKey}>
            <div
              className={
                stat.tone === "success"
                  ? "font-rv-mono text-[18px] font-medium leading-none text-rv-success sm:text-[22px]"
                  : "font-rv-mono text-[18px] font-medium leading-none text-foreground sm:text-[22px]"
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
