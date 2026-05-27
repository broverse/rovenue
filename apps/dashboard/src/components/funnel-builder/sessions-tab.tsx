import { useState } from "react";
import { cn } from "../../lib/cn";
import type { Session } from "./types";

type Props = {
  sessions: ReadonlyArray<Session>;
};

const RANGES = ["24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];

const SESSIONS_STARTED: Record<Range, number> = {
  "24h": 412,
  "7d": 2841,
  "30d": 11920,
};

const STATE_COLOR: Record<Session["state"], string> = {
  in_progress: "text-rv-accent-500",
  paid: "text-rv-success",
  abandoned: "text-rv-mute-500",
  completed: "text-rv-mute-700",
};

const STATE_LABEL: Record<Session["state"], string> = {
  in_progress: "in progress",
  paid: "paid",
  abandoned: "abandoned",
  completed: "completed",
};

/**
 * Sessions tab — operational view of recent funnel runs. KPI strip on
 * top, paginated-style table below. For deep analytics the user is
 * pointed at the Charts page.
 */
export function SessionsTab({ sessions }: Props) {
  const [range, setRange] = useState<Range>("7d");

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
                onClick={() => setRange(r)}
                className={cn(
                  "h-6 cursor-pointer rounded px-2.5 text-[11px] font-medium transition",
                  range === r
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
          <Kpi label="SESSIONS STARTED" value={SESSIONS_STARTED[range].toLocaleString()} detail="▲ 18.2%" />
          <Kpi label="COMPLETION RATE" value="66.1%" detail="target ≥ 60%" />
          <Kpi label="PAYWALL VIEW RATE" value="71.4%" detail="% of started → reached paywall" />
          <Kpi
            label="PAYWALL → PAID"
            value="14.0%"
            detail="▲ 1.4pp vs prev"
            valueClass="text-rv-success"
          />
          <Kpi label="MEDIAN TIME" value="2m 18s" detail="start → success" />
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
                  <Th>Answers</Th>
                  <Th>Started</Th>
                  <Th>Last activity</Th>
                  <Th>Purchase</Th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]"
                  >
                    <td className="px-3.5 py-2.5 font-rv-mono text-[12px]">{s.id}</td>
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
                      {s.currentPage}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <span className="inline-flex h-[18px] items-center rounded-full bg-rv-c4 px-2 font-rv-mono text-[10px] text-rv-mute-600">
                        {s.utm}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5 font-rv-mono text-[12px]">{s.answers} / 5</td>
                    <td className="px-3.5 py-2.5 text-[12px] text-rv-mute-600">{s.started}</td>
                    <td className="px-3.5 py-2.5 text-[12px] text-rv-mute-600">{s.last}</td>
                    <td className="px-3.5 py-2.5">
                      {s.paid ? (
                        <span className="font-rv-mono text-[11px] text-rv-success">
                          ✓ {s.paid}
                        </span>
                      ) : (
                        <span className="text-[11px] text-rv-mute-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

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
