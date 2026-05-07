import { Check } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ConnectorDefinition } from "./types";

type ConnectorChipProps = {
  connector: ConnectorDefinition;
  selected: boolean;
  onToggle: () => void;
};

export function ConnectorChip({
  connector,
  selected,
  onToggle,
}: ConnectorChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md border bg-rv-c2 p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500 focus-visible:ring-offset-1 focus-visible:ring-offset-rv-bg",
        selected
          ? "border-rv-accent-500 bg-rv-accent-500/10"
          : "border-rv-divider hover:border-rv-divider-strong",
      )}
    >
      <div
        className="flex size-[30px] shrink-0 items-center justify-center rounded-md font-rv-mono text-[12px] font-semibold text-white"
        style={{ background: connector.bg }}
        aria-hidden="true"
      >
        {connector.name.slice(0, 2)}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium text-foreground">
          {connector.name}
        </div>
        <div className="font-rv-mono text-[10px] text-rv-mute-500">
          {connector.meta}
        </div>
      </div>
      {selected ? (
        <Check
          className="absolute right-2.5 top-2 size-3.5 text-rv-accent-400"
          strokeWidth={2.6}
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}
