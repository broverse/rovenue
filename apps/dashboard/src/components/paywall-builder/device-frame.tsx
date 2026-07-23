import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { CanvasDeviceSpec } from "./device-catalog";

type Props = {
  spec: CanvasDeviceSpec;
  /** CSS transform scale applied to the whole frame. */
  scale: number;
  scheme: "light" | "dark";
  showSafeArea: boolean;
  /** Show the device label + dimensions above the frame (all-sizes grid). */
  label?: boolean;
  children: ReactNode;
};

/**
 * One accurate device frame: chassis at logical `w × h` (scaled via CSS
 * transform), a status bar, the right notch/cutout, and a content area
 * inset by the device's safe areas so a StickyFooter sits above the
 * home indicator — the same inset the SDK applies on device. All layout
 * is in logical points; `scale` only scales the visual.
 */
export function DeviceFrame({ spec, scale, scheme, showSafeArea, label, children }: Props) {
  const dark = scheme === "dark";
  return (
    <div style={{ width: spec.w * scale }}>
      {label && (
        <div className="mb-1.5 text-center font-rv-mono text-[10px] text-rv-mute-500">
          <span className="uppercase">{spec.platform}</span> · {spec.label} · {spec.w}×{spec.h}
        </div>
      )}
      <div style={{ width: spec.w * scale, height: spec.h * scale }}>
        <div
          className="relative overflow-hidden rounded-[38px] border border-white/15 bg-black"
          style={{ width: spec.w, height: spec.h, transform: `scale(${scale})`, transformOrigin: "top left" }}
        >
          <div className={cn("relative h-full w-full overflow-hidden", dark ? "bg-[#0B0B0F]" : "bg-white")}>
            {/* status bar */}
            <div
              className={cn(
                "absolute inset-x-0 top-0 z-20 flex items-end justify-between px-6 pb-1 font-rv-mono text-[11px]",
                dark ? "text-white" : "text-black",
              )}
              style={{ height: spec.safeTop }}
            >
              <span>9:41</span>
              <span className="tracking-tighter">{spec.platform === "ios" ? "􀙯 􀛨 􀺸" : "▮ ▮ ◲"}</span>
            </div>

            {/* notch / cutout */}
            {spec.notch === "dynamic-island" && (
              <div className="absolute left-1/2 top-2.5 z-30 h-[26px] w-[92px] -translate-x-1/2 rounded-full bg-black" />
            )}
            {spec.notch === "punch-hole" && (
              <div className="absolute left-1/2 top-2.5 z-30 h-3 w-3 -translate-x-1/2 rounded-full bg-black" />
            )}

            {/* scrollable content, inset by the safe areas */}
            <div
              className="absolute inset-x-0 overflow-auto"
              style={{ top: spec.safeTop, bottom: spec.safeBottom }}
            >
              {children}
            </div>

            {/* safe-area guides */}
            {showSafeArea && (
              <>
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 z-40 border-b border-dashed border-rv-accent-500/70 bg-rv-accent-500/10"
                  style={{ height: spec.safeTop }}
                >
                  <span className="absolute bottom-0.5 right-1 font-rv-mono text-[8px] text-rv-accent-500">
                    safe top {spec.safeTop}
                  </span>
                </div>
                {spec.safeBottom > 0 && (
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 z-40 border-t border-dashed border-rv-accent-500/70 bg-rv-accent-500/10"
                    style={{ height: spec.safeBottom }}
                  >
                    <span className="absolute right-1 top-0.5 font-rv-mono text-[8px] text-rv-accent-500">
                      safe bottom {spec.safeBottom}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
