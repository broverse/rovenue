import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn";

type ConnectionRowProps = {
  name: ReactNode;
  meta: ReactNode;
  glyph: ReactNode;
  glyphStyle?: CSSProperties;
  glyphClassName?: string;
  primary?: boolean;
  primaryLabel?: string;
  action: ReactNode;
};

export function ConnectionRow({
  name,
  meta,
  glyph,
  glyphStyle,
  glyphClassName,
  primary,
  primaryLabel,
  action,
}: ConnectionRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-white/5 py-3 last:border-b-0">
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md font-rv-mono text-[12px] font-semibold text-white",
          glyphClassName,
        )}
        style={glyphStyle}
      >
        {glyph}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
          {name}
          {primary && primaryLabel ? (
            <span className="rounded bg-rv-accent-500/15 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-accent-400">
              {primaryLabel}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 break-all font-rv-mono text-[11px] text-rv-mute-500">{meta}</div>
      </div>
      <div className="ml-11 sm:ml-0">{action}</div>
    </div>
  );
}
