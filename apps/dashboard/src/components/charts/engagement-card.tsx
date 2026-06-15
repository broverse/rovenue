import { useProjectEngagement } from "../../lib/hooks/useProjectEngagement";

type Props = { projectId: string };

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function EngagementCard({ projectId }: Props) {
  const { data, isLoading } = useProjectEngagement({ projectId });
  const points = data?.points ?? [];
  const totalSessions = points.reduce((a, p) => a + p.sessionCount, 0);
  const weightedMs = points.reduce((a, p) => a + p.avgSessionMs * p.sessionCount, 0);
  const avgMs = totalSessions > 0 ? weightedMs / totalSessions : 0;
  const peakActive = points.reduce((a, p) => Math.max(a, p.activeSubscribers), 0);

  const tile = (label: string, value: string) => (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">{label}</div>
      <div className="mt-1 font-rv-mono text-[18px] font-medium tabular-nums">{value}</div>
    </div>
  );

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
        Engagement (last 30 days)
      </div>
      <div className="grid grid-cols-3 gap-4">
        {tile("Sessions", isLoading ? "—" : totalSessions.toLocaleString())}
        {tile("Avg duration", isLoading ? "—" : fmtDuration(avgMs))}
        {tile("Peak DAU", isLoading ? "—" : peakActive.toLocaleString())}
      </div>
    </section>
  );
}
