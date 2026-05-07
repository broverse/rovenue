import type { HistoryEntry } from "./types";

type Props = {
  entries: ReadonlyArray<HistoryEntry>;
};

const TONE_CLASS: Record<HistoryEntry["tone"], string> = {
  primary: "bg-rv-accent-500",
  success: "bg-rv-success",
  danger: "bg-rv-danger",
  neutral: "bg-rv-mute-500",
};

/**
 * Vertical timeline of recent flag changes. Each row is a status dot, a
 * short action title, free-form detail, and a relative timestamp.
 */
export function ChangeLog({ entries }: Props) {
  return (
    <div className="flex flex-col">
      {entries.map((entry, i) => (
        <div
          key={`${entry.when}-${i}`}
          className="grid grid-cols-[14px_1fr_auto] gap-2.5 py-1.5 text-[12px]"
        >
          <div className="flex flex-col items-center">
            <span
              className={`mt-1 size-2 rounded-full ${TONE_CLASS[entry.tone]}`}
            />
            {i < entries.length - 1 && (
              <span className="mt-0.5 w-px flex-1 bg-rv-divider" />
            )}
          </div>
          <div>
            <div className="font-medium">{entry.action}</div>
            <div className="mt-0.5 text-[11px] text-rv-mute-500">
              {entry.detail}
            </div>
          </div>
          <div className="font-rv-mono text-[10px] text-rv-mute-500">
            {entry.when}
          </div>
        </div>
      ))}
    </div>
  );
}
