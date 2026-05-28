// Renderer for `query.metrics.*` tool outputs. Today only
// `query.metrics.mrr` is implemented end-to-end on the backend; the
// other metric tools surface a "not implemented" placeholder so the
// chat surface still degrades gracefully when the model picks one.
//
// MRR values arrive in minor units (cents) — divide by 100 before
// displaying.
type MrrPayload = {
  series: Array<{ t: string; mrr: number }>;
  delta?: number;
  currency?: string;
};

export function MetricsChart({
  name,
  output,
}: {
  name: string;
  output: unknown;
}) {
  if (name === "query.metrics.mrr") {
    const o = output as MrrPayload;
    const last = o.series?.[o.series.length - 1];
    return (
      <div className="rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs">
        <p className="text-[10px] uppercase tracking-wide text-rv-mute-500">
          MRR
        </p>
        <p className="mt-0.5 text-sm font-medium text-foreground">
          {last
            ? `${(last.mrr / 100).toLocaleString()} ${o.currency ?? ""}`
            : "—"}
        </p>
        <SparklineRow points={o.series?.map((s) => s.mrr) ?? []} />
      </div>
    );
  }
  return (
    <div className="rounded-md border border-rv-divider bg-rv-c2 p-3 text-xs text-rv-mute-600">
      {name} is not implemented yet.
    </div>
  );
}

function SparklineRow({ points }: { points: number[] }) {
  if (points.length === 0) return null;
  const max = Math.max(...points, 1);
  return (
    <div className="mt-2 flex h-6 items-end gap-0.5">
      {points.map((p, i) => (
        <div
          key={i}
          className="w-1 rounded-sm bg-rv-c4"
          style={{ height: `${Math.max(2, (p / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}
