import type { Variant } from "./types";

type Props = {
  variants: ReadonlyArray<Variant>;
};

/**
 * Multi-variant split bar + per-variant legend rows. Used when a flag is
 * tied to a multivariate experiment (e.g. headline copy A/B/C).
 */
export function VariantSplit({ variants }: Props) {
  return (
    <>
      <div className="flex h-[22px] overflow-hidden rounded border border-rv-divider">
        {variants.map((v) => (
          <div
            key={v.value}
            className="flex min-w-0 items-center justify-center overflow-hidden px-1.5 font-rv-mono text-[10px] text-white transition-[flex] [text-shadow:0_1px_0_rgba(0,0,0,0.4)]"
            style={{ flex: v.pct, background: v.color }}
          >
            {v.pct}%
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex flex-col gap-1">
        {variants.map((v) => (
          <div
            key={v.value}
            className="flex items-center justify-between font-rv-mono text-[11px]"
          >
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2 rounded-sm"
                style={{ background: v.color }}
              />
              {v.value}
            </span>
            <span className="text-rv-mute-500">{v.pct}%</span>
          </div>
        ))}
      </div>
    </>
  );
}
