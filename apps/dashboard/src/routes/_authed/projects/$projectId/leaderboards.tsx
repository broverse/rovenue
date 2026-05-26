import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../lib/cn";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  useTopConsumers,
  useTopSpenders,
} from "../../../../lib/hooks/useProjectAdmin";

export const Route = createFileRoute("/_authed/projects/$projectId/leaderboards")({
  component: LeaderboardsRoute,
});

function LeaderboardsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/leaderboards",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <LeaderboardsPage projectId={projectId} />;
}

type Board = "spenders" | "consumers";
type RangeDays = 7 | 30 | 90;

const BOARDS: ReadonlyArray<Board> = ["spenders", "consumers"];
const RANGES: ReadonlyArray<RangeDays> = [7, 30, 90];

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function LeaderboardsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [board, setBoard] = useState<Board>("spenders");
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);

  // Trailing window, snapped to day boundaries to match CH grain.
  // API schema requires full ISO datetime — we send T00:00:00Z and
  // the server slices the date portion for the CH parameter.
  const { from, to, fromDay, toDay } = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - rangeDays * 86_400_000);
    const fromDay = isoDay(start);
    const toDay = isoDay(end);
    return {
      from: `${fromDay}T00:00:00.000Z`,
      to: `${toDay}T00:00:00.000Z`,
      fromDay,
      toDay,
    };
  }, [rangeDays]);

  const spenders = useTopSpenders({
    projectId,
    from,
    to,
    limit: 20,
  });
  const consumers = useTopConsumers({
    projectId,
    from,
    to,
    limit: 20,
  });

  const active = board === "spenders" ? spenders : consumers;
  const entries = active.data?.entries ?? [];

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("leaderboards.title", "Leaderboards")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t("leaderboards.subtitle", "Trailing {{days}} days · {{from}} → {{to}}", {
              days: rangeDays,
              from: fromDay,
              to: toDay,
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label={t("leaderboards.rangeAriaLabel", "Date range")}
            className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5"
          >
            {RANGES.map((d) => (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={rangeDays === d}
                onClick={() => setRangeDays(d)}
                className={cn(
                  "h-6 cursor-pointer rounded px-2.5 text-xs font-medium transition",
                  rangeDays === d
                    ? "bg-rv-c4 text-foreground"
                    : "text-rv-mute-600 hover:text-foreground",
                )}
              >
                {t("leaderboards.range.lastNd", "{{days}}d", { days: d })}
              </button>
            ))}
          </div>
          <div
            role="tablist"
            aria-label={t("leaderboards.ariaLabel", "Leaderboard type")}
            className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5"
          >
            {BOARDS.map((b) => (
              <button
                key={b}
                type="button"
                role="tab"
                aria-selected={board === b}
                onClick={() => setBoard(b)}
                className={cn(
                  "h-6 cursor-pointer rounded px-2.5 text-xs font-medium transition",
                  board === b
                    ? "bg-rv-c4 text-foreground"
                    : "text-rv-mute-600 hover:text-foreground",
                )}
              >
                {b === "spenders"
                  ? t("leaderboards.tabs.spenders", "Top spenders")
                  : t("leaderboards.tabs.consumers", "Top consumers")}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <div className="grid grid-cols-[60px_minmax(0,1fr)_140px_120px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          <span>{t("leaderboards.cols.rank", "#")}</span>
          <span>{t("leaderboards.cols.subscriber", "Subscriber")}</span>
          <span className="text-right">
            {board === "spenders"
              ? t("leaderboards.cols.totalUsd", "USD")
              : t("leaderboards.cols.totalCredits", "Credits")}
          </span>
          <span className="text-right">
            {t("leaderboards.cols.events", "Events")}
          </span>
        </div>
        {active.isLoading ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("common.loading", "Loading…")}
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("leaderboards.empty", "Not enough data for this window yet.")}
          </div>
        ) : (
          entries.map((entry, idx) => (
            <div
              key={entry.subscriberId}
              className="grid grid-cols-[60px_minmax(0,1fr)_140px_120px] items-center gap-3 border-b border-rv-divider px-4 py-2 text-[12px] last:border-b-0"
            >
              <span className="font-rv-mono text-rv-mute-500">
                {idx + 1}
              </span>
              <span className="truncate font-rv-mono">{entry.subscriberId}</span>
              <span className="text-right font-rv-mono tabular-nums">
                {board === "spenders"
                  ? `$${Number(entry.totalUsd).toFixed(2)}`
                  : Number(entry.totalUsd).toFixed(0)}
              </span>
              <span className="text-right font-rv-mono tabular-nums text-rv-mute-500">
                {entry.eventCount.toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
