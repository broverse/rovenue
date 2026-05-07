import { useTranslation } from "react-i18next";
import { ArrowUpRight, GitBranch } from "lucide-react";
import { Chip, type ChipProps } from "../../ui/chip";
import { CopyButton } from "../../ui/copy-button";
import type { SdkPackage } from "./types";

const STATUS_TONE: Record<SdkPackage["status"], NonNullable<ChipProps["tone"]>> = {
  stable: "success",
  beta: "primary",
  preview: "warning",
  planned: "default",
};

type Props = {
  pkg: SdkPackage;
};

export function SdkPackageCard({ pkg }: Props) {
  const { t } = useTranslation();
  const Icon = pkg.icon;

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-rv-divider bg-rv-c1 p-4 transition hover:border-rv-divider-strong">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-md border border-rv-divider bg-rv-c2">
            <Icon className={pkg.iconClass} size={16} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] font-semibold text-foreground">
                {t(`sdkApi.packages.items.${pkg.nameKey}`)}
              </span>
              <Chip tone={STATUS_TONE[pkg.status]}>
                {t(`sdkApi.packages.status.${pkg.status}`)}
              </Chip>
            </div>
            <div className="mt-0.5 text-[11.5px] text-rv-mute-500">
              {t(`sdkApi.packages.targets.${pkg.targetKey}`)}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-rv-mono text-[12px] font-medium text-foreground">
            v{pkg.version}
          </div>
          <div className="text-[11px] text-rv-mute-500">
            {t(`sdkApi.packages.published.${pkg.publishedKey}`)}
          </div>
        </div>
      </header>

      <div className="rounded-md border border-rv-divider bg-rv-c2 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <code className="truncate font-rv-mono text-[11.5px] text-rv-mute-700">
            {pkg.install}
          </code>
          <CopyButton
            size="xs"
            value={pkg.install}
            label={t("sdkApi.copy.idle")}
            copiedLabel={t("sdkApi.copy.copied")}
          />
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
        <span className="inline-flex items-center gap-1.5 text-rv-mute-600">
          <GitBranch size={12} />
          <span className="font-rv-mono text-rv-mute-700">{pkg.repoLabel}</span>
        </span>
        <a
          href="#"
          className="inline-flex items-center gap-1 text-rv-accent-500 hover:text-rv-accent-400"
        >
          {t(`sdkApi.packages.docsLinks.${pkg.docsKey}`)}
          <ArrowUpRight size={11} />
        </a>
      </footer>
    </article>
  );
}
