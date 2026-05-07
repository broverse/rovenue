import { useTranslation } from "react-i18next";
import { Check, RotateCw, TriangleAlert, X } from "lucide-react";
import { cn } from "../../lib/cn";
import type { TimelineEntry, TimelineEntryKind } from "./types";

const DOT_TONE: Record<TimelineEntryKind, string> = {
  purchase: "bg-rv-accent-500 text-white",
  renewal: "bg-rv-success text-white",
  cancel: "bg-rv-warning text-white",
  fail: "bg-rv-danger text-white",
  trial: "bg-rv-c4 text-rv-mute-700",
};

function DotIcon({ kind }: { kind: TimelineEntryKind }) {
  switch (kind) {
    case "purchase":
      return <Check size={9} />;
    case "renewal":
      return <RotateCw size={9} />;
    case "cancel":
      return <X size={9} />;
    case "fail":
      return <TriangleAlert size={9} />;
    case "trial":
      return <span className="text-[9px] font-semibold">T</span>;
  }
}

type Props = { entries: ReadonlyArray<TimelineEntry> };

/**
 * Vertical event timeline rendered in the user detail panel. The vertical
 * rule is drawn as a `::before` on the container so that dots can sit on
 * top via z-index without overlapping the line through their centers.
 */
export function ActivityTimeline({ entries }: Props) {
  const { t } = useTranslation();
  return (
    <div className="relative px-4 pb-4 before:absolute before:bottom-4 before:left-6 before:top-1 before:w-px before:bg-rv-divider before:content-['']">
      {entries.map((entry, idx) => (
        <div key={idx} className="relative flex gap-3 py-2">
          <div
            className={cn(
              "relative z-[1] mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ring-2 ring-rv-c1",
              DOT_TONE[entry.kind],
            )}
          >
            <DotIcon kind={entry.kind} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-foreground">
              <span className="font-rv-mono text-rv-mute-700">
                {t(`subscribers.timeline.events.${entry.typeKey}`)}
              </span>
            </div>
            <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
              {entry.product} · {entry.amount}
            </div>
          </div>
          <div className="shrink-0 font-rv-mono text-[10px] text-rv-mute-500">
            {entry.at}
          </div>
        </div>
      ))}
    </div>
  );
}
