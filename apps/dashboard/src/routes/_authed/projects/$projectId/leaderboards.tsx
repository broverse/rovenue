import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "../../../../lib/cn";
import { ApiError } from "../../../../lib/api";
import { Button } from "../../../../ui/button";
import { useProject } from "../../../../lib/hooks/useProject";
import { useVirtualCurrencies } from "../../../../lib/hooks/useVirtualCurrencies";
import {
  useConfiguredLeaderboards,
  useCreateConfiguredLeaderboard,
  useDeleteConfiguredLeaderboard,
  useLeaderboardCurrent,
  useLeaderboardSeasons,
  useSeasonStandings,
  useTopConsumers,
  useTopSpenders,
  useUpdateConfiguredLeaderboard,
  type ConfiguredLeaderboard,
} from "../../../../lib/hooks/useProjectAdmin";
import {
  CADENCE_LABEL_KEYS,
  LeaderboardFormDialog,
  LIVE_SEASON_VALUE,
  METRIC_LABEL_KEYS,
  SeasonSelector,
} from "../../../../components/leaderboards";

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

export function LeaderboardsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();

  return (
    <>
      <header className="pb-5">
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
          {t("leaderboards.title", "Leaderboards")}
        </h1>
      </header>

      <ConfiguredLeaderboardsSection projectId={projectId} />

      <hr className="my-8 border-rv-divider" />

      <AdHocRangeView projectId={projectId} />
    </>
  );
}

// =============================================================
// Configured, season-based leaderboards
// =============================================================

function ConfiguredLeaderboardsSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const listQuery = useConfiguredLeaderboards(projectId);
  const currenciesQuery = useVirtualCurrencies(projectId);
  const currencies = currenciesQuery.data ?? [];
  const leaderboards = listQuery.data ?? [];

  const create = useCreateConfiguredLeaderboard(projectId);
  const [createOpen, setCreateOpen] = useState(false);

  const [editTarget, setEditTarget] = useState<ConfiguredLeaderboard | null>(null);
  const update = useUpdateConfiguredLeaderboard(projectId, editTarget?.id ?? "");

  const del = useDeleteConfiguredLeaderboard(projectId);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = leaderboards.find((l) => l.id === selectedId) ?? null;

  async function handleDelete(row: ConfiguredLeaderboard) {
    if (!window.confirm(t("leaderboards.configured.delete.confirm", { name: row.name }))) {
      return;
    }
    setDeleteError(null);
    try {
      await del.mutateAsync(row.id);
      if (selectedId === row.id) setSelectedId(null);
    } catch (err) {
      setDeleteError(
        err instanceof ApiError
          ? err.message
          : t("leaderboards.configured.delete.error"),
      );
    }
  }

  return (
    <section className="flex flex-col gap-4 pb-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold leading-6">
            {t("leaderboards.configured.sectionTitle")}
          </h2>
          <p className="mt-0.5 max-w-xl text-[12px] text-rv-mute-500">
            {t("leaderboards.configured.sectionSubtitle")}
          </p>
        </div>
        <Button variant="solid-primary" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={13} />
          {t("leaderboards.configured.new")}
        </Button>
      </div>

      {deleteError && (
        <p className="text-[12px] text-rv-danger" role="alert">
          {deleteError}
        </p>
      )}

      {listQuery.isLoading ? (
        <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-8 text-center text-[12px] text-rv-mute-500">
          {t("common.loading")}
        </div>
      ) : leaderboards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-rv-divider-strong bg-rv-c1 px-4 py-8 text-center">
          <p className="text-[13px] font-medium text-foreground">
            {t("leaderboards.configured.empty.title")}
          </p>
          <p className="mt-1 text-[12px] text-rv-mute-500">
            {t("leaderboards.configured.empty.body")}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
          {leaderboards.map((lb) => (
            <div
              key={lb.id}
              className="flex items-center justify-between gap-3 border-b border-rv-divider px-4 py-2.5 text-[12px] last:border-b-0"
            >
              <button
                type="button"
                aria-label={t("leaderboards.configured.actions.viewAria", { name: lb.name })}
                aria-pressed={selectedId === lb.id}
                onClick={() => setSelectedId(lb.id === selectedId ? null : lb.id)}
                className={cn(
                  "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-2 py-1 text-left transition",
                  selectedId === lb.id ? "bg-rv-c4" : "hover:bg-rv-c2",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {lb.name}
                </span>
                <span className="truncate font-rv-mono text-rv-mute-500">
                  {lb.identifier}
                </span>
                <span className="rounded-full border border-rv-divider bg-rv-c2 px-2 py-0.5 text-[10px] text-rv-mute-700">
                  {t(METRIC_LABEL_KEYS[lb.metric])}
                </span>
                <span className="rounded-full border border-rv-divider bg-rv-c2 px-2 py-0.5 text-[10px] text-rv-mute-700">
                  {t(CADENCE_LABEL_KEYS[lb.cadence])}
                </span>
                <span className="text-[10px] text-rv-mute-500">
                  {t("leaderboards.configured.list.entryLimit", { count: lb.entryLimit })}
                </span>
                <span
                  className={cn(
                    "text-[10px] font-medium",
                    lb.isEnabled ? "text-rv-success" : "text-rv-mute-500",
                  )}
                >
                  {lb.isEnabled ? t("common.active") : t("common.inactive")}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={t("common.edit")}
                  onClick={() => setEditTarget(lb)}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-foreground"
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  aria-label={t("common.delete")}
                  onClick={() => void handleDelete(lb)}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        // `key` forces a remount (and a fresh `seasonSelection` state) on
        // every leaderboard switch -- otherwise clicking straight from one
        // leaderboard's row to another's (never through `null`) keeps the
        // panel's previously-selected season id alive, and it goes on
        // fetching that OTHER leaderboard's frozen standings under the
        // newly-selected leaderboard's name/header.
        <LeaderboardStandingsPanel
          key={selected.id}
          projectId={projectId}
          leaderboard={selected}
        />
      )}

      <LeaderboardFormDialog
        open={createOpen}
        mode="create"
        currencies={currencies}
        onClose={() => setCreateOpen(false)}
        onSave={async (body) => {
          await create.mutateAsync(body as Parameters<typeof create.mutateAsync>[0]);
          setCreateOpen(false);
        }}
      />

      {editTarget && (
        <LeaderboardFormDialog
          open={Boolean(editTarget)}
          mode="edit"
          initial={editTarget}
          currencies={currencies}
          onClose={() => setEditTarget(null)}
          onSave={async (body) => {
            await update.mutateAsync(body as Parameters<typeof update.mutateAsync>[0]);
            setEditTarget(null);
          }}
        />
      )}
    </section>
  );
}

function LeaderboardStandingsPanel({
  projectId,
  leaderboard,
}: {
  projectId: string;
  leaderboard: ConfiguredLeaderboard;
}) {
  const { t } = useTranslation();
  const [seasonSelection, setSeasonSelection] = useState<string>(LIVE_SEASON_VALUE);
  const isLive = seasonSelection === LIVE_SEASON_VALUE;

  const seasonsQuery = useLeaderboardSeasons(projectId, leaderboard.id);
  const currentQuery = useLeaderboardCurrent(
    projectId,
    isLive ? leaderboard.id : null,
  );
  const standingsQuery = useSeasonStandings(
    projectId,
    isLive ? null : seasonSelection,
  );

  const totalLabelKey =
    leaderboard.metric === "TOP_SPENDERS" ? "leaderboards.cols.totalUsd" : "leaderboards.cols.totalCredits";

  const loading = isLive ? currentQuery.isLoading : standingsQuery.isLoading;
  const season = isLive ? currentQuery.data?.season ?? null : standingsQuery.data?.season ?? null;
  const rows = isLive
    ? (currentQuery.data?.entries ?? []).map((e, idx) => ({ ...e, rank: idx + 1 }))
    : standingsQuery.data?.standings ?? [];

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <h3 className="text-[13px] font-medium text-foreground">{leaderboard.name}</h3>
        <SeasonSelector
          seasons={seasonsQuery.data ?? []}
          value={seasonSelection}
          onChange={setSeasonSelection}
        />
      </div>

      <div className="overflow-hidden rounded-md border border-rv-divider">
        <div className="grid grid-cols-[60px_minmax(0,1fr)_140px_120px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          <span>{t("leaderboards.cols.rank")}</span>
          <span>{t("leaderboards.cols.subscriber")}</span>
          <span className="text-right">{t(totalLabelKey)}</span>
          <span className="text-right">{t("leaderboards.cols.events")}</span>
        </div>
        {loading ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("common.loading")}
          </div>
        ) : isLive && season === null ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("leaderboards.configured.standings.empty")}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("leaderboards.empty")}
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row.subscriberId}
              className="grid grid-cols-[60px_minmax(0,1fr)_140px_120px] items-center gap-3 border-b border-rv-divider px-4 py-2 text-[12px] last:border-b-0"
            >
              <span className="font-rv-mono text-rv-mute-500">{row.rank}</span>
              <span className="truncate font-rv-mono">{row.subscriberId}</span>
              <span className="text-right font-rv-mono tabular-nums">
                {leaderboard.metric === "TOP_SPENDERS"
                  ? `$${Number(row.score).toFixed(2)}`
                  : Number(row.score).toFixed(0)}
              </span>
              <span className="text-right font-rv-mono tabular-nums text-rv-mute-500">
                {row.eventCount.toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// =============================================================
// Ad-hoc range view (top spenders / top consumers)
// =============================================================
//
// Pre-existing, non-configured quick view -- kept exactly as it worked
// before Task 7, just extracted into its own component so it can sit
// alongside the new configured-leaderboards UI on the same route.

function AdHocRangeView({ projectId }: { projectId: string }) {
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
