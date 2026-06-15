import { useProjectCreditsRollup } from "../../lib/hooks/useProjectCredits";

type Props = { projectId: string };

export function CreditVolumeCard({ projectId }: Props) {
  const { data, isLoading } = useProjectCreditsRollup({ projectId, windowDays: 28 });
  const points = data?.volume ?? [];
  const max = Math.max(1, ...points.map((p) => Math.max(p.issued, p.burned)));

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
        Credit volume (28 days)
      </div>
      {isLoading ? (
        <div className="font-rv-mono text-[12px] text-rv-mute-500">—</div>
      ) : (
        <div className="flex h-32 items-end gap-1">
          {points.map((p) => (
            <div
              key={p.day}
              className="flex flex-1 flex-col justify-end gap-0.5"
              title={`${p.day}: +${p.issued} / −${p.burned}`}
            >
              <div className="w-full rounded-sm bg-rv-accent-500" style={{ height: `${(p.issued / max) * 100}%` }} />
              <div className="w-full rounded-sm bg-rv-mute-500" style={{ height: `${(p.burned / max) * 100}%` }} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
