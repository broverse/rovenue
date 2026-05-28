import { useRoviUsage } from "../../lib/hooks/useRoviUsage";

export function RoviUsageBar() {
  const { data, isLoading } = useRoviUsage();
  if (isLoading || !data) return null;
  if (data.unlimited) {
    return (
      <div className="flex items-center justify-end gap-2 border-t border-rv-divider px-3 py-1.5 text-[10px] text-rv-mute-500">
        <span>Unlimited</span>
      </div>
    );
  }
  const pct = Math.min(100, data.messages.percent);
  const tone =
    pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-rv-c4";
  return (
    <div className="border-t border-rv-divider px-3 py-1.5 text-[10px] text-rv-mute-600">
      <div className="flex items-center justify-between">
        <span>
          {data.messages.used.toLocaleString()} /{" "}
          {(data.messages.limit ?? 0).toLocaleString()} messages
        </span>
        <span>resets in {data.period.daysLeft}d</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-rv-c2">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
