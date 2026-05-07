import { Fragment } from "react";
import { cn } from "../../lib/cn";
import { SQL_TOKEN_COLOR } from "./format";
import type { SqlLine, SqlTokenKind } from "./types";

type Props = {
  lines: ReadonlyArray<SqlLine>;
};

/**
 * Read-only mock SQL pane — line numbers on the left, hand-tokenized
 * pairs (kind, text) rendered as colored spans. Last line gets the
 * "current line" highlight + blinking caret.
 */
export function SqlEditor({ lines }: Props) {
  return (
    <div className="relative max-h-80 min-h-[280px] overflow-auto bg-rv-bg py-3.5 font-rv-mono text-[13px] leading-[1.7]">
      {lines.map((line, i) => {
        const isCurrent = i === lines.length - 1;
        const isFullComment = line.length === 2 && line[0] === "cm";
        return (
          <div
            key={i}
            className={cn(
              "grid grid-cols-[44px_1fr]",
              isCurrent
                ? "bg-rv-accent-500/8"
                : "hover:bg-white/[0.02]",
            )}
          >
            <span
              className={cn(
                "select-none pr-3.5 text-right",
                isCurrent ? "text-rv-accent-400 opacity-100" : "text-rv-mute-500 opacity-50",
              )}
            >
              {i + 1}
            </span>
            <span className="whitespace-pre pr-3.5">
              {isFullComment ? (
                <span className={SQL_TOKEN_COLOR.cm}>{line[1]}</span>
              ) : (
                <SegmentedLine line={line} />
              )}
              {isCurrent && (
                <span
                  className="ml-0 inline-block animate-pulse font-bold text-rv-accent-400"
                  aria-hidden
                >
                  |
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SegmentedLine({ line }: { line: SqlLine }) {
  const segments: Array<{ kind: SqlTokenKind; text: string }> = [];
  for (let i = 0; i < line.length; i += 2) {
    const kind = line[i] as SqlTokenKind;
    const text = line[i + 1] ?? "";
    segments.push({ kind, text });
  }
  return (
    <>
      {segments.map((seg, j) => (
        <Fragment key={j}>
          <span className={SQL_TOKEN_COLOR[seg.kind]}>{seg.text}</span>
        </Fragment>
      ))}
    </>
  );
}
