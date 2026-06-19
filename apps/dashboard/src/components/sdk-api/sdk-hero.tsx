import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import { ArrowUpRight, BookOpen, KeyRound } from "lucide-react";
import { Button } from "../../ui/button";
import { Chip } from "../../ui/chip";
import { CodeBlock } from "../../ui/code-block";
import { API_BASE_URL } from "./mock-data";
import type { SdkHeroStats } from "./types";

const heroStyle: CSSProperties = {
  background:
    "linear-gradient(135deg, color-mix(in srgb, var(--color-rv-accent-500) 14%, var(--color-rv-c1)), var(--color-rv-c1) 60%)",
};

type Props = {
  stats: SdkHeroStats;
  onCreateKey?: () => void;
};

export function SdkHero({ stats, onCreateKey }: Props) {
  const { t } = useTranslation();

  const tiles = [
    {
      labelKey: "calls",
      value: stats.callsValue,
      unit: stats.callsUnit,
      description: t(stats.callsDescriptionKey, stats.callsDescriptionVars),
      tone: "default" as const,
    },
    {
      labelKey: "success",
      value: stats.successValue,
      unit: stats.successUnit,
      description: t(stats.successDescriptionKey),
      tone: "success" as const,
    },
    {
      labelKey: "latency",
      value: stats.latencyValue,
      unit: stats.latencyUnit,
      description: t(stats.latencyDescriptionKey),
      tone: "default" as const,
    },
    {
      labelKey: "installs",
      value: stats.installsValue,
      unit: stats.installsUnit,
      description: t(stats.installsDescriptionKey),
      tone: "default" as const,
    },
  ];

  return (
    <div
      style={heroStyle}
      className="mb-4 grid items-center gap-5 rounded-[10px] border border-rv-divider px-4 py-5 sm:gap-6 sm:px-7 sm:py-6 grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
          <Chip tone="primary">{t("sdkApi.hero.eyebrow")}</Chip>
          <Chip>{t("sdkApi.hero.versionLabel", { version: "2026-04-01" })}</Chip>
        </div>
        <h2 className="text-[18px] font-semibold leading-snug tracking-tight text-foreground sm:text-[22px]">
          {t("sdkApi.hero.title")}
        </h2>
        <p className="mt-1.5 max-w-[620px] text-[12.5px] leading-[1.55] text-rv-mute-600 sm:text-[13px]">
          {t("sdkApi.hero.description")}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="solid-primary" size="sm" onClick={onCreateKey}>
            <KeyRound size={13} />
            {t("sdkApi.hero.actions.generateKey")}
          </Button>
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("sdkApi.hero.actions.openDocs")}
            <ArrowUpRight size={12} />
          </Button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map((tile) => (
            <div key={tile.labelKey}>
              <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t(`sdkApi.hero.stats.${tile.labelKey}`)}
              </div>
              <div className="mt-1 font-rv-mono text-[17px] font-medium leading-none text-foreground sm:text-[20px]">
                {tile.value}
                {tile.unit ? (
                  <span className="ml-1 text-[11px] font-normal text-rv-mute-500">
                    {tile.unit}
                  </span>
                ) : null}
              </div>
              <div
                className={
                  tile.tone === "success"
                    ? "mt-1 font-rv-mono text-[11px] text-rv-success"
                    : "mt-1 font-rv-mono text-[11px] text-rv-mute-500"
                }
              >
                {tile.description}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="min-w-0">
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("sdkApi.hero.healthcheckLabel")}
        </div>
        <CodeBlock
          language="bash"
          filename={t("sdkApi.hero.healthcheckFile")}
          code={`curl ${API_BASE_URL}/health \\\n  -H "Authorization: Bearer rvn_sk_live_…" \\\n  -H "Rovenue-Version: 2026-04-01"`}
          copyLabel={t("sdkApi.copy.idle")}
          copiedLabel={t("sdkApi.copy.copied")}
          caption={t("sdkApi.hero.healthcheckCaption")}
        />
      </div>
    </div>
  );
}
