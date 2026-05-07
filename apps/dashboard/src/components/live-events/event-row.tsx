import { cn } from "../../lib/cn";
import { formatAmount, formatClockTime } from "./format";
import { PlatformBadge } from "./platform-badge";
import type { LiveEvent } from "./types";

type Props = {
  event: LiveEvent;
  selected: boolean;
  onClick: () => void;
};

const rowBase =
  "relative grid cursor-pointer items-center gap-3 border-b border-white/[0.04] px-3.5 py-2.5 text-[12px] transition hover:bg-rv-c2";

// Match the stream header: 90px / 1fr / 110px / 1fr / 80px / 100px / 90px
const rowGrid =
  "grid-cols-[90px_minmax(0,1fr)_110px_minmax(0,1fr)_80px_100px_90px]";

const collapsedGrid =
  "max-[1280px]:grid-cols-[80px_minmax(0,1fr)_90px_70px_90px]";

export function EventRow({ event, selected, onClick }: Props) {
  const isRefund = event.amount != null && event.amount < 0;
  return (
    <button
      type="button"
      onClick={onClick}
      data-new={event.isNew ? "true" : undefined}
      className={cn(
        rowBase,
        rowGrid,
        collapsedGrid,
        "w-full text-left",
        selected &&
          "bg-rv-accent-500/10 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-rv-accent-500",
        event.isNew && "animate-rv-fade-in",
      )}
    >
      <span className="font-rv-mono text-[11px] text-rv-mute-500">
        {formatClockTime(event.receivedAt)}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: event.typeMeta.color }}
          aria-hidden="true"
        />
        <span className="truncate font-rv-mono text-[12px] font-medium text-rv-mute-800">
          {event.typeMeta.label}
        </span>
      </span>
      <span className="truncate font-rv-mono text-[11px] text-rv-mute-600">
        {event.user}
      </span>
      <span className="truncate text-[12px] text-rv-mute-700 max-[1280px]:hidden">
        {event.product}
      </span>
      <span className="max-[1280px]:hidden">
        <PlatformBadge platform={event.platform} />
      </span>
      <span
        className={cn(
          "text-right font-rv-mono text-[12px] tabular-nums",
          isRefund ? "text-rv-danger" : "text-foreground",
        )}
      >
        {formatAmount(event.amount)}
      </span>
      <span className="text-right font-rv-mono text-[11px] text-rv-mute-500">
        {event.country}
      </span>
    </button>
  );
}
