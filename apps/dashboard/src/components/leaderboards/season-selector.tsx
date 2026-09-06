import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { LeaderboardSeasonRow } from "../../lib/hooks/useProjectAdmin";

/** Sentinel `value` for the live/current-season tab (never a real season id). */
export const LIVE_SEASON_VALUE = "live";

interface Props {
  /** Full season history for one leaderboard, any order. */
  seasons: LeaderboardSeasonRow[];
  value: string;
  onChange: (value: string) => void;
}

/**
 * Tab-style switcher between the live (open) season and each CLOSED
 * season's frozen snapshot. Selecting a past season must resolve to that
 * season's own id -- callers fetch `/seasons/:id/standings` for it, never
 * `/:id/current` (see leaderboards.tsx `useSeasonStandings` wiring).
 */
export function SeasonSelector({ seasons, value, onChange }: Props) {
  const { t } = useTranslation();
  const closedSeasons = [...seasons]
    .filter((s) => s.status === "CLOSED")
    .sort((a, b) => b.seasonNumber - a.seasonNumber);

  return (
    <div
      role="tablist"
      aria-label={t("leaderboards.configured.season.ariaLabel")}
      className="inline-flex flex-wrap gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === LIVE_SEASON_VALUE}
        onClick={() => onChange(LIVE_SEASON_VALUE)}
        className={cn(
          "h-6 cursor-pointer rounded px-2.5 text-xs font-medium transition",
          value === LIVE_SEASON_VALUE
            ? "bg-rv-c4 text-foreground"
            : "text-rv-mute-600 hover:text-foreground",
        )}
      >
        {t("common.live")}
      </button>
      {closedSeasons.map((season) => (
        <button
          key={season.id}
          type="button"
          role="tab"
          aria-selected={value === season.id}
          onClick={() => onChange(season.id)}
          className={cn(
            "h-6 cursor-pointer rounded px-2.5 text-xs font-medium transition",
            value === season.id
              ? "bg-rv-c4 text-foreground"
              : "text-rv-mute-600 hover:text-foreground",
          )}
        >
          {t("leaderboards.configured.season.ordinal", { number: season.seasonNumber })}
        </button>
      ))}
    </div>
  );
}
