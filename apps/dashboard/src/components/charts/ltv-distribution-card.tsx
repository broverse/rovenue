import { useProjectLtv } from "../../lib/hooks/useProjectLtv";
import { formatCurrencyCompact } from "./format";

type Props = { projectId: string };

function bandLabel(lowerUsd: number, upperUsd: number | null): string {
  if (upperUsd == null) return `${formatCurrencyCompact(lowerUsd)}+`;
  return `${formatCurrencyCompact(lowerUsd)}–${formatCurrencyCompact(upperUsd)}`;
}

export function LtvDistributionCard({ projectId }: Props) {
  const { data, isLoading } = useProjectLtv(projectId);
  const buckets = data?.histogram ?? [];
  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 flex items-baseline justify-between">
        <div className="font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
          Lifetime value distribution
        </div>
        <div className="font-rv-mono text-[11px] text-rv-mute-500">
          {isLoading ? "—" : `median ${formatCurrencyCompact(Number(data?.medianUsd ?? 0))}`}
        </div>
      </div>
      <div className="space-y-1.5">
        {buckets.map((b) => (
          <div key={`${b.lowerUsd}`} className="flex items-center gap-2">
            <div className="w-20 shrink-0 text-right font-rv-mono text-[10px] text-rv-mute-500">
              {bandLabel(b.lowerUsd, b.upperUsd)}
            </div>
            <div className="h-3 flex-1 rounded-sm bg-rv-c2">
              <div
                className="h-3 rounded-sm bg-rv-accent-500"
                style={{ width: `${(b.count / max) * 100}%` }}
              />
            </div>
            <div className="w-8 shrink-0 font-rv-mono text-[10px] tabular-nums text-rv-mute-600">
              {b.count}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
