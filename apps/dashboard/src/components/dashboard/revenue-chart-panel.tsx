import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui-components/react/menu";
import { Check, ChevronDown } from "lucide-react";
import { buttonVariants } from "../../ui/button";
import { Card, CardHeader } from "../../ui/card";
import { cn } from "../../lib/cn";
import { StackedAreaChart, type ChartSeries } from "./stacked-area-chart";

type Props = {
  /** Map of metric label → series. Keys become the metric switcher. */
  metrics: Record<string, ChartSeries[]>;
  categories: string[];
  initialMetric?: string;
};

/**
 * Stacked-area revenue chart with a Base UI menu metric switcher. Subtitle
 * adapts to the selected metric.
 */
export function RevenueChartPanel({ metrics, categories, initialMetric }: Props) {
  const { t } = useTranslation();
  const keys = Object.keys(metrics);
  const [metric, setMetric] = useState(initialMetric ?? keys[0] ?? "");
  const series = metrics[metric] ?? [];
  const subtitle =
    metric === "MRR" ? t("panels.revenue.subtitleMrr") : t("panels.revenue.subtitle", { metric });

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={t("panels.revenue.title")}
        subtitle={subtitle}
        right={
          <Menu.Root>
            <Menu.Trigger
              className={cn(buttonVariants({ variant: "flat", size: "sm" }), "h-7 text-xs")}
            >
              {metric}
              <ChevronDown size={12} />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner sideOffset={4} align="end" className="z-50">
                <Menu.Popup className="min-w-[200px] rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
                  {keys.map((k) => (
                    <Menu.Item
                      key={k}
                      onClick={() => setMetric(k)}
                      className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground"
                    >
                      {k === metric ? <Check size={13} /> : <span className="size-[13px]" />}
                      {k}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        }
      />
      <div className="flex-1 px-5 pb-5 pt-4">
        <StackedAreaChart series={series} categories={categories} />
        <div className="mt-2 flex flex-wrap gap-4">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-[12px] text-rv-mute-600">
              <span className="size-2 rounded-sm" style={{ background: s.color }} />
              {s.label}
              {s.negative && ` ${t("panels.revenue.neg")}`}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}
