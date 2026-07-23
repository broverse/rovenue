import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { CanvasDeviceSpec } from "./device-catalog";

// Frame chrome — named so the device look is tunable in one place instead of
// scattered as arbitrary Tailwind values / raw literals.
/** Chassis corner radius, logical points. */
const CHASSIS_RADIUS = 38;
/** Screen background per scheme (light uses the renderer's own white). */
const DARK_SCREEN_BG = "#0B0B0F";
/** Status-bar placeholder clock — the canonical Apple marketing time. */
const STATUS_BAR_CLOCK = "9:41";
/** Decorative status-bar glyph clusters (signal · wifi · battery). The iOS
 * cluster is SF Symbols (renders only with SF fonts — cosmetic on the web). */
const STATUS_GLYPHS_IOS = "􀙯 􀛨 􀺸";
const STATUS_GLYPHS_ANDROID = "▮ ▮ ◲";
/** Notch/cutout geometry, logical points. */
const NOTCH_TOP = 10;
const DYNAMIC_ISLAND = { width: 92, height: 26 } as const;
const PUNCH_HOLE = { width: 12, height: 12 } as const;
/** Stacking order inside the frame. */
const Z_STATUS_BAR = 20;
const Z_NOTCH = 30;
const Z_SAFE_GUIDE = 40;

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
          className="relative overflow-hidden border border-white/15 bg-black"
          style={{
            width: spec.w,
            height: spec.h,
            borderRadius: CHASSIS_RADIUS,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <div
            className="relative h-full w-full overflow-hidden"
            style={dark ? { backgroundColor: DARK_SCREEN_BG } : { backgroundColor: "#FFFFFF" }}
          >
            {/* status bar */}
            <div
              className={cn(
                "absolute inset-x-0 top-0 flex items-end justify-between px-6 pb-1 font-rv-mono text-[11px]",
                dark ? "text-white" : "text-black",
              )}
              style={{ height: spec.safeTop, zIndex: Z_STATUS_BAR }}
            >
              <span>{STATUS_BAR_CLOCK}</span>
              <span className="tracking-tighter">
                {spec.platform === "ios" ? STATUS_GLYPHS_IOS : STATUS_GLYPHS_ANDROID}
              </span>
            </div>

            {/* notch / cutout */}
            {spec.notch === "dynamic-island" && (
              <div
                className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black"
                style={{ top: NOTCH_TOP, width: DYNAMIC_ISLAND.width, height: DYNAMIC_ISLAND.height, zIndex: Z_NOTCH }}
              />
            )}
            {spec.notch === "punch-hole" && (
              <div
                className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black"
                style={{ top: NOTCH_TOP, width: PUNCH_HOLE.width, height: PUNCH_HOLE.height, zIndex: Z_NOTCH }}
              />
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
                  className="pointer-events-none absolute inset-x-0 top-0 border-b border-dashed border-rv-accent-500/70 bg-rv-accent-500/10"
                  style={{ height: spec.safeTop, zIndex: Z_SAFE_GUIDE }}
                >
                  <span className="absolute bottom-0.5 right-1 font-rv-mono text-[8px] text-rv-accent-500">
                    safe top {spec.safeTop}
                  </span>
                </div>
                {spec.safeBottom > 0 && (
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-dashed border-rv-accent-500/70 bg-rv-accent-500/10"
                    style={{ height: spec.safeBottom, zIndex: Z_SAFE_GUIDE }}
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
