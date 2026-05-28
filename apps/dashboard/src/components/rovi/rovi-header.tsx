import { X } from "lucide-react";
import { useRovi } from "../../lib/hooks/useRovi";

export function RoviHeader({ providerLabel, modelLabel }: { providerLabel?: string; modelLabel?: string }) {
  const { setOpen } = useRovi();
  return (
    <div className="flex h-12 items-center gap-2 border-b border-rv-divider px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-sm font-medium text-foreground">Rovi</span>
        {providerLabel && modelLabel ? (
          <span className="truncate rounded border border-rv-divider bg-rv-c2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rv-mute-600">
            {providerLabel} · {modelLabel}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Close Rovi"
        className="ml-auto flex size-7 items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
      >
        <X size={14} />
      </button>
    </div>
  );
}
