import { component, useService } from "impair";
import { cn } from "../../lib/cn";
import { FunnelSessionsViewModel } from "./vm/funnel-sessions.vm";
import type { Range } from "../../lib/services/funnel-sessions-api";
import type { FunnelSessionRowDto } from "../../lib/services/funnel-sessions-api";
import { SessionDetailDrawer } from "./session-detail-drawer";

const RANGES: ReadonlyArray<Range> = ["24h", "7d", "30d"];

const STATE_COLOR: Record<FunnelSessionRowDto["state"], string> = {
  in_progress: "text-rv-accent-500",
  paid: "text-rv-success",
  abandoned: "text-rv-mute-500",
  completed: "text-rv-mute-700",
};

const STATE_LABEL: Record<FunnelSessionRowDto["state"], string> = {
  in_progress: "in progress",
  paid: "paid",
  abandoned: "abandoned",
  completed: "completed",
};

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function fmtRel(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const SessionsTab = component(() => {
  const vm = useService(FunnelSessionsViewModel);
  const stats = vm.stats;

  return (
    <div className="flex-1 overflow-y-auto bg-rv-bg px-6 py-8">
      <div className="mx-auto max-w-[1200px]">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="m-0 text-[18px] font-semibold tracking-tight">Recent sessions</h2>
            <p className="mt-1 m-0 text-[13px] text-rv-mute-500">
              Operational view — postgres-backed, lightweight. For deep analytics open Charts.
            </p>
          </div>
          <div className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => vm.setRange(r)}
                className={cn(
                  "h-6 cursor-pointer rounded px-2.5 text-[11px] font-medium transition",
                  vm.range === r
                    ? "bg-rv-c4 text-foreground"
                    : "text-rv-mute-600 hover:text-foreground",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 grid grid-cols-1 overflow-hidden rounded-lg border border-rv-divider bg-rv-c1 sm:grid-cols-2 lg:grid-cols-5">
          <Kpi label="SESSIONS STARTED" value={(stats?.started ?? 0).toLocaleString()} detail={vm.range} />
          <Kpi label="COMPLETION RATE" value={fmtPct(stats?.completionRate ?? 0)} detail="completed / started" />
          <Kpi label="PAYWALL VIEW RATE" value={fmtPct(stats?.paywallViewRate ?? 0)} detail="approx" />
          <Kpi label="PAID CONVERSION" value={fmtPct(stats?.paidConversion ?? 0)} detail="paid / started" valueClass="text-rv-success" />
          <Kpi label="MEDIAN TIME" value={fmtDuration(stats?.medianDurationMs ?? null)} detail="start → terminal" />
        </div>

        <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr>
                  <Th>Session</Th>
                  <Th>State</Th>
                  <Th>Current page</Th>
                  <Th>UTM</Th>
                  <Th>Started</Th>
                  <Th>Last activity</Th>
                </tr>
              </thead>
              <tbody>
                {vm.sessions.length === 0 && !vm.isLoading && (
                  <tr>
                    <td colSpan={6} className="px-3.5 py-10 text-center text-[12px] text-rv-mute-500">
                      No sessions in this window yet.
                    </td>
                  </tr>
                )}
                {vm.sessions.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => vm.open(s.id)}
                    className="cursor-pointer border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-3.5 py-2.5 font-rv-mono text-[12px]">{s.id.slice(0, 10)}</td>
                    <td className="px-3.5 py-2.5">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 text-[11px] font-medium",
                          STATE_COLOR[s.state],
                        )}
                      >
                        {s.state === "in_progress" && (
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        )}
                        {STATE_LABEL[s.state]}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5 font-rv-mono text-[12px] text-rv-mute-700">
                      {s.currentPageId ?? "—"}
                    </td>
                    <td className="px-3.5 py-2.5">
                      {s.utmSource ? (
                        <span className="inline-flex h-[18px] items-center rounded-full bg-rv-c4 px-2 font-rv-mono text-[10px] text-rv-mute-600">
                          {s.utmSource}
                        </span>
                      ) : (
                        <span className="text-[11px] text-rv-mute-500">—</span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 text-[12px] text-rv-mute-600">{fmtRel(s.startedAt)}</td>
                    <td className="px-3.5 py-2.5 text-[12px] text-rv-mute-600">{fmtRel(s.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <SessionDetailDrawer />
    </div>
  );
});

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="sticky top-0 z-[1] border-b border-rv-divider bg-rv-c2 px-3.5 py-2 text-left font-rv-mono text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
      {children}
    </th>
  );
}

function Kpi({
  label,
  value,
  detail,
  valueClass,
}: {
  label: string;
  value: string;
  detail: string;
  valueClass?: string;
}) {
  return (
    <div className="border-r border-rv-divider px-4 py-3.5 last:border-r-0">
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 font-rv-mono text-[20px] font-medium leading-none tabular-nums",
          valueClass,
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 font-rv-mono text-[11px] text-rv-mute-500">{detail}</div>
    </div>
  );
}
