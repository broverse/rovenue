import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock } from "../../ui/code-block";
import { cn } from "../../lib/cn";
import { PLATFORMS } from "./mock-data";
import type { PlatformId } from "./types";

type Props = {
  initialPlatform?: PlatformId;
};

export function QuickstartCard({ initialPlatform = "react-native" }: Props) {
  const { t } = useTranslation();
  const [active, setActive] = useState<PlatformId>(initialPlatform);
  const platform = PLATFORMS.find((p) => p.id === active) ?? PLATFORMS[0];

  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rv-divider px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold leading-5 text-foreground">
            {t("sdkApi.quickstart.title")}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
            {t("sdkApi.quickstart.subtitle")}
          </p>
        </div>
        <div
          className="-mb-px inline-flex flex-wrap items-center gap-1 rounded-md border border-rv-divider bg-rv-c2 p-0.5"
          role="tablist"
          aria-label={t("sdkApi.quickstart.tabsAria")}
        >
          {PLATFORMS.map((option) => {
            const selected = option.id === active;
            return (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActive(option.id)}
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center rounded px-2.5 text-[12px] transition",
                  selected
                    ? "bg-rv-c4 text-foreground"
                    : "text-rv-mute-600 hover:text-foreground",
                )}
              >
                {t(`sdkApi.quickstart.platforms.${option.labelKey}`)}
              </button>
            );
          })}
        </div>
      </header>

      <div className="grid items-start gap-4 px-5 py-5 lg:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="font-rv-mono text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
              {t("sdkApi.quickstart.installLabel")}
            </span>
            <span className="text-[11px] text-rv-mute-500">
              {t("sdkApi.quickstart.installHint")}
            </span>
          </div>
          <CodeBlock
            language={platform.language}
            filename={platform.installFilename}
            code={platform.installCommand}
            copyLabel={t("sdkApi.copy.idle")}
            copiedLabel={t("sdkApi.copy.copied")}
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="font-rv-mono text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
              {t("sdkApi.quickstart.initLabel")}
            </span>
            <span className="text-[11px] text-rv-mute-500">
              {t("sdkApi.quickstart.initHint")}
            </span>
          </div>
          <CodeBlock
            language={platform.initLanguage}
            filename={platform.initFilename}
            code={platform.initSnippet}
            copyLabel={t("sdkApi.copy.idle")}
            copiedLabel={t("sdkApi.copy.copied")}
          />
        </div>
      </div>
    </section>
  );
}
