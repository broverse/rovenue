import { useTranslation } from "react-i18next";
import { Check, MoreHorizontal, Star } from "lucide-react";
import { Button } from "../../ui/button";
import { Chip } from "../../ui/chip";
import { Segmented } from "../../ui/segmented";
import { cn } from "../../lib/cn";
import type { ChartType, RangeOption } from "./types";

const CHART_TYPES: ReadonlyArray<ChartType> = ["line", "area", "bar"];
const RANGES: ReadonlyArray<RangeOption> = ["1M", "3M", "6M", "12M", "YTD", "All"];

type Props = {
  titleKey: string;
  versionLabel: string;
  starred: boolean;
  onToggleStar: () => void;
  chartType: ChartType;
  onChartTypeChange: (next: ChartType) => void;
  range: RangeOption;
  onRangeChange: (next: RangeOption) => void;
  compare: boolean;
  onToggleCompare: () => void;
};

export function ChartToolbar({
  titleKey,
  versionLabel,
  starred,
  onToggleStar,
  chartType,
  onChartTypeChange,
  range,
  onRangeChange,
  compare,
  onToggleCompare,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-rv-divider bg-rv-c1 px-3.5 py-2.5">
      <div className="flex min-w-[200px] flex-1 items-center gap-2.5">
        <button
          type="button"
          onClick={onToggleStar}
          aria-label={t(starred ? "charts.toolbar.unstar" : "charts.toolbar.star")}
          aria-pressed={starred}
          className={cn(
            "cursor-pointer transition",
            starred ? "text-rv-warning" : "text-rv-mute-500 hover:text-rv-warning",
          )}
        >
          <Star size={14} className={starred ? "fill-rv-warning" : ""} />
        </button>
        <h2 className="text-[15px] font-semibold">{t(titleKey)}</h2>
        <Chip tone="default" className="ml-1">
          {versionLabel}
        </Chip>
      </div>

      <Segmented<ChartType>
        options={CHART_TYPES}
        value={chartType}
        onChange={onChartTypeChange}
        ariaLabel={t("charts.toolbar.chartType")}
      />

      <Segmented<RangeOption>
        options={RANGES}
        value={range}
        onChange={onRangeChange}
        ariaLabel={t("charts.toolbar.range")}
      />

      <Button
        variant="flat"
        size="sm"
        onClick={onToggleCompare}
        aria-pressed={compare}
        className="h-7"
      >
        <Check size={12} className={compare ? "opacity-100" : "opacity-30"} />
        {t("charts.toolbar.compare")}
      </Button>

      <Button
        variant="light"
        size="icon"
        className="size-7"
        aria-label={t("charts.toolbar.more")}
      >
        <MoreHorizontal size={14} />
      </Button>
    </div>
  );
}
