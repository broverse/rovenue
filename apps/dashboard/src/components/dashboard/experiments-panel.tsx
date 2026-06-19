import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { Check, FlaskConical } from "lucide-react";
import { buttonVariants } from "../../ui/button";
import { Card, CardFooter, CardHeader } from "../../ui/card";
import { Chip } from "../../ui/chip";
import { Segmented } from "../../ui/segmented";

export type Experiment = {
  key: string;
  status: "running" | "completed";
  days?: number;
  variants: number;
  /** Bayesian confidence (0-100). `null` while the analytics
   *  rollup hasn't computed it yet — the panel hides the bar and
   *  drops the trailing "% confidence" copy. */
  confidence: number | null;
  uplift?: number | null;
  winner?: string;
};

const FILTER_KEYS = ["running", "completed", "all"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

type Props = { experiments: ReadonlyArray<Experiment>; projectId: string };

export function ExperimentsPanel({ experiments, projectId }: Props) {
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
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-10 text-center">
            <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-rv-divider bg-rv-c2 text-rv-mute-500">
              <FlaskConical size={16} />
            </div>
            <h3 className="mb-1 text-[13px] font-semibold">{t("panels.experiments.empty.title")}</h3>
            <p className="max-w-[260px] text-[12px] text-rv-mute-500">
              {t("panels.experiments.empty.body")}
            </p>
          </div>
        ) : (
          filtered.map((x) => (
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
                {renderDescription(x, t)}
              </div>
              {x.confidence !== null && (
                <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-rv-c4">
                  <span
                    className={`block h-full rounded-full transition-[width] duration-500 ease-out ${
                      x.status === "completed" ? "bg-rv-success" : "bg-rv-accent-500"
                    }`}
                    style={{ width: `${Math.max(0, Math.min(100, x.confidence))}%` }}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>
      <CardFooter>
        <Link
          to="/projects/$projectId/experiments"
          params={{ projectId }}
          className={buttonVariants({ variant: "light", className: "h-6 p-0 text-xs" })}
        >
          {t("panels.experiments.viewAll")}
        </Link>
      </CardFooter>
    </Card>
  );
}

function renderDescription(
  x: Experiment,
  t: (k: string, v?: Record<string, unknown>) => string,
) {
  if (x.status === "completed") {
    if (!x.winner) {
      return <>{t("panels.experiments.completedDescriptionNoWinner")}</>;
    }
    if (x.uplift === null || x.uplift === undefined) {
      return (
        <Trans
          i18nKey="panels.experiments.completedDescriptionNoUplift"
          values={{ winner: x.winner }}
          components={[<span key="w" className="font-rv-mono" />]}
        />
      );
    }
    return (
      <Trans
        i18nKey="panels.experiments.completedDescription"
        values={{ winner: x.winner, uplift: x.uplift }}
        components={[
          <span key="w" className="font-rv-mono" />,
          <span key="u" className="font-rv-mono text-rv-success" />,
        ]}
      />
    );
  }
  if (x.days === undefined || x.days <= 0) {
    return <>{t("panels.experiments.runningDescriptionNew")}</>;
  }
  if (x.confidence === null) {
    return (
      <Trans
        i18nKey="panels.experiments.runningDescriptionNoConfidence"
        values={{ days: x.days }}
        components={[<span key="d" className="font-rv-mono" />]}
      />
    );
  }
  return (
    <Trans
      i18nKey="panels.experiments.runningDescription"
      values={{ days: x.days, confidence: x.confidence }}
      components={[<span key="d" className="font-rv-mono" />]}
    />
  );
}
