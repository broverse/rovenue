import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { Button } from "../../ui/button";
import { Card, CardFooter, CardHeader } from "../../ui/card";
import { Chip } from "../../ui/chip";
import { Segmented } from "../../ui/segmented";

export type Experiment = {
  key: string;
  status: "running" | "completed";
  days?: number;
  variants: number;
  confidence: number;
  uplift?: number | null;
  winner?: string;
};

const FILTER_KEYS = ["running", "completed", "all"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

type Props = { experiments: ReadonlyArray<Experiment> };

/**
 * Active experiments with status / confidence bar / winner badge.
 */
export function ExperimentsPanel({ experiments }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<FilterKey>("running");

  const filterLabels = useMemo(
    () =>
      FILTER_KEYS.map((k) => t(`panels.experiments.filters.${k}`)) as unknown as readonly [string, string, string],
    [t],
  );
  const selectedLabel = filterLabels[FILTER_KEYS.indexOf(filter)] as string;

  const filtered = experiments.filter((e) => {
    if (filter === "all") return true;
    if (filter === "running") return e.status === "running";
    return e.status === "completed";
  });

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={t("panels.experiments.title")}
        subtitle={t("panels.experiments.subtitle")}
        right={
          <Segmented
            options={filterLabels}
            value={selectedLabel}
            onChange={(label) => {
              const idx = filterLabels.indexOf(label as string);
              if (idx >= 0) setFilter(FILTER_KEYS[idx]!);
            }}
            ariaLabel={t("panels.experiments.filterAriaLabel")}
          />
        }
      />
      <div className="flex-1 px-5 pb-1 pt-1">
        {filtered.map((x) => (
          <div key={x.key} className="border-b border-rv-divider py-3 last:border-b-0">
            <div className="flex items-center gap-2">
              {x.status === "completed" ? (
                <Check size={12} className="text-rv-success" />
              ) : (
                <span
                  className="size-2 rounded-full bg-rv-accent-500"
                  style={{ boxShadow: "0 0 0 3px color-mix(in srgb, var(--color-rv-accent-500) 15%, transparent)" }}
                />
              )}
              <span className="font-rv-mono text-[13px] font-semibold text-rv-mute-800">{x.key}</span>
              {x.winner && <Chip tone="success">{t("panels.experiments.winner")}</Chip>}
              <Chip tone="default" className="ml-auto">
                {t("panels.experiments.variants", { count: x.variants })}
              </Chip>
            </div>
            <div className="mt-1 text-[12px] text-rv-mute-500">
              {x.status === "completed" ? (
                <Trans
                  i18nKey="panels.experiments.completedDescription"
                  values={{ winner: x.winner ?? "", uplift: x.uplift ?? 0 }}
                  components={[
                    <span key="w" className="font-rv-mono" />,
                    <span key="u" className="font-rv-mono text-rv-success" />,
                  ]}
                />
              ) : (
                <Trans
                  i18nKey="panels.experiments.runningDescription"
                  values={{ days: x.days ?? 0, confidence: x.confidence }}
                  components={[<span key="d" className="font-rv-mono" />]}
                />
              )}
            </div>
            <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-rv-c4">
              <span
                className={`block h-full rounded-full transition-[width] duration-500 ease-out ${
                  x.status === "completed" ? "bg-rv-success" : "bg-rv-accent-500"
                }`}
                style={{ width: `${x.confidence}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <CardFooter>
        <Button variant="light" className="h-6 p-0 text-xs">
          {t("panels.experiments.viewAll")}
        </Button>
      </CardFooter>
    </Card>
  );
}
