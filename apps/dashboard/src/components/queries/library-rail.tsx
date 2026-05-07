import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowRightLeft,
  Coins,
  LineChart,
  Plus,
  RotateCw,
  Tag,
  TrendingUp,
  Users2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { SearchInput } from "../../ui/search-input";
import {
  PINNED_QUERY_IDS,
  RECENT_RUNS,
  RETENTION_PLATFORM_QUERY_IDS,
  REVENUE_QUERY_IDS,
  SAVED_QUERY_BY_ID,
} from "./mock-data";
import type { QueryRunStatus } from "./types";

const ICON_FOR_QUERY: Readonly<Record<string, LucideIcon>> = {
  mrr_by_country: LineChart,
  trial_funnel: ArrowRightLeft,
  cohort_retention: Users2,
  refund_anomalies: AlertTriangle,
  arpu_segment: LineChart,
  ltv_30d: TrendingUp,
  churn_predict: AlertTriangle,
  ios_vs_android: RotateCw,
  promo_attribution: Tag,
  fx_impact: Coins,
};

const STATUS_DOT: Readonly<Record<QueryRunStatus, string>> = {
  ok: "bg-rv-success",
  warn: "bg-rv-warning",
  err: "bg-rv-danger",
};

type Props = {
  selectedId: string;
  onSelect: (next: string) => void;
};

/**
 * Left rail — saved queries grouped by section, search box on top, then a
 * "Recent runs" mini-feed with status dots and durations. Mirrors the design's
 * compact 240px library shelf.
 */
export function LibraryRail({ selectedId, onSelect }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();

  const filterIds = (ids: ReadonlyArray<string>) => {
    if (!term) return ids;
    return ids.filter((id) =>
      SAVED_QUERY_BY_ID[id]?.name.toLowerCase().includes(term),
    );
  };

  const renderItem = (id: string) => {
    const q = SAVED_QUERY_BY_ID[id];
    if (!q) return null;
    const Icon = ICON_FOR_QUERY[id] ?? LineChart;
    const active = id === selectedId;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onSelect(id)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] transition",
          active
            ? "bg-rv-accent-500/14 text-rv-accent-400"
            : "text-rv-mute-700 hover:bg-rv-c2",
        )}
      >
        <Icon size={12} className="shrink-0 opacity-80" />
        <span className="flex-1 truncate">{q.name}</span>
      </button>
    );
  };

  const sections = [
    { key: "pinned", ids: filterIds(PINNED_QUERY_IDS) },
    { key: "revenue", ids: filterIds(REVENUE_QUERY_IDS) },
    { key: "retentionPlatform", ids: filterIds(RETENTION_PLATFORM_QUERY_IDS) },
  ].filter((s) => s.ids.length > 0);

  return (
    <aside className="sticky top-[76px] flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="flex items-center gap-1.5 border-b border-rv-divider px-3 py-2.5">
        <h3 className="flex-1 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("queries.library.title")}
        </h3>
        <Button
          variant="light"
          size="icon"
          aria-label={t("queries.library.newAria")}
          className="size-[22px]"
        >
          <Plus size={11} />
        </Button>
      </div>
      <div className="border-b border-rv-divider p-2.5">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("queries.library.searchPlaceholder")}
          aria-label={t("queries.library.searchAria")}
          size="sm"
        />
      </div>
      <div className="flex-1 overflow-y-auto py-1.5">
        {sections.map((section) => (
          <div key={section.key}>
            <div className="px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
              {t(`queries.library.sections.${section.key}`)}
            </div>
            {section.ids.map(renderItem)}
          </div>
        ))}

        <div className="px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("queries.library.sections.recentRuns")}
        </div>
        {RECENT_RUNS.slice(0, 5).map((run) => {
          const q = SAVED_QUERY_BY_ID[run.queryId];
          return (
            <button
              key={run.id}
              type="button"
              onClick={() => onSelect(run.queryId)}
              className="grid w-full cursor-pointer grid-cols-[8px_1fr_auto_auto] items-center gap-2.5 px-3 py-1.5 text-left text-[11.5px] transition hover:bg-rv-c2"
            >
              <span
                className={cn("size-1.5 rounded-full", STATUS_DOT[run.status])}
                aria-hidden
              />
              <span className="truncate font-rv-mono text-rv-mute-700">
                {q?.name ?? run.queryId}
              </span>
              <span className="font-rv-mono text-[10px] text-rv-mute-500">
                {t(`queries.recent.when.${run.whenKey}`)}
              </span>
              <span className="text-right font-rv-mono text-[10px] text-rv-mute-500">
                {run.ms ? `${run.ms}ms` : "—"}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
