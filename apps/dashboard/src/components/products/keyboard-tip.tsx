import type { ReactNode } from "react";
import { Kbd } from "../../ui/kbd";

type Props = {
  children: ReactNode;
  /** Optional decorator on the left — defaults to the lightbulb glyph. */
  prefix?: ReactNode;
};

/**
 * Bottom-of-page hint strip — same visual language as the live-events
 * `RateStrip`, used here for keyboard shortcut hints.
 */
export function KeyboardTip({ children, prefix = "💡" }: Props) {
  return (
    <div className="mt-2.5 flex items-center gap-2 px-3.5 py-2 font-rv-mono text-[11px] tabular-nums text-rv-mute-500">
      <span aria-hidden="true">{prefix}</span>
      <span>{children}</span>
    </div>
  );
}

export { Kbd };
