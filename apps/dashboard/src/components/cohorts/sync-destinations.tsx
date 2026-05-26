import { useTranslation } from "react-i18next";
type CohortDot = "primary" | "success" | "warning" | "danger" | "violet" | "muted";

const DOT_COLOR: Record<CohortDot, string> = {
  primary: "var(--color-rv-accent-500)",
  success: "var(--color-rv-success)",
  warning: "var(--color-rv-warning)",
  danger: "var(--color-rv-danger)",
  violet: "var(--color-rv-violet)",
  muted: "var(--color-rv-mute-500)",
};

function dotColor(tone: CohortDot): string {
  return DOT_COLOR[tone];
}
import { SYNC_DESTINATIONS } from "./mock-data";
import type { SyncDestination } from "./types";

function stateLabel(t: (k: string, v?: Record<string, unknown>) => string, dest: SyncDestination): string {
  switch (dest.state.kind) {
    case "syncedAgo":
      return t("cohorts.sync.states.syncedAgo", { ago: dest.state.ago });
    case "notSynced":
      return t("cohorts.sync.states.notSynced");
    case "activeCount":
      return t("cohorts.sync.states.activeCount", { count: dest.state.count });
    case "ruleReferences":
      return t("cohorts.sync.states.ruleReferences", { count: dest.state.count });
  }
}

export function SyncDestinations() {
  const { t } = useTranslation();

  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="border-b border-rv-divider px-4 py-3.5">
        <h3 className="text-[14px] font-semibold">{t("cohorts.sync.title")}</h3>
        <p className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
          {t("cohorts.sync.subtitle")}
        </p>
      </header>
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {SYNC_DESTINATIONS.map((dest) => {
          const dot =
            dest.status === "on" ? dotColor(dest.dot) : "var(--color-rv-mute-400)";
          return (
            <div
              key={dest.id}
              className="rounded-md border border-rv-divider bg-rv-c2 px-3.5 py-3"
            >
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium text-foreground">
                  {t(`cohorts.sync.items.${dest.id}`)}
                </div>
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: dot }}
                />
              </div>
              <div className="mt-1 font-rv-mono text-[11px] text-rv-mute-500">
                {stateLabel(t, dest)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
