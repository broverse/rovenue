import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { FlagRow } from "./flag-row";
import type { FeatureFlag } from "./types";

type Props = {
  flags: ReadonlyArray<FeatureFlag>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
};

export function FlagsList({ flags, selectedKey, onSelect, onToggle }: Props) {
  const { t } = useTranslation();

  return (
    <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div
        className={cn(
          "grid items-center gap-3.5 border-b border-rv-divider bg-rv-c2 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
          FlagRow.GRID,
        )}
      >
        <div />
        <div>{t("featureFlags.cols.flag")}</div>
        <div>{t("featureFlags.cols.rollout")}</div>
        <div>{t("featureFlags.cols.evals24h")}</div>
        <div>{t("featureFlags.cols.lastChanged")}</div>
        <div className="text-right">{t("featureFlags.cols.on")}</div>
      </div>

      {flags.map((flag, index) => (
        <FlagRow
          key={flag.key}
          flag={flag}
          index={index}
          selected={selectedKey === flag.key}
          onSelect={() => onSelect(flag.key)}
          onToggle={() => onToggle(flag.key)}
        />
      ))}

      {flags.length === 0 && (
        <div className="px-5 py-16 text-center text-[12px] text-rv-mute-500">
          {t("featureFlags.list.empty")}
        </div>
      )}
    </div>
  );
}
