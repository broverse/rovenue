# Paywall Canvas Fidelity (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the paywall builder's canvas in accurate per-device frames (real dimensions, safe-area insets, correct notch/cutout) with a safe-area overlay, an all-sizes grid, and canvas-bar platform/device pickers.

**Architecture:** A pure device-catalog module drives a presentational `DeviceFrame` component that the canvas renders one-per-device (single) or many (all-sizes). The view model gains ephemeral canvas state (device id, platform, safe-area/all-sizes toggles). Device/platform selection moves from the top bar to the canvas bar. Dashboard-only — no API, no wire, no DB, no shared-schema change.

**Tech Stack:** React + `impair` DI (`@state`/`@derived`/`component`/`useService`), `react-i18next`, `lucide-react`, Tailwind (`rv-*` tokens + `cn`), Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-23-paywall-canvas-fidelity-design.md`.
- Dashboard-only. Every change is under `apps/dashboard/src/components/paywall-builder/`. No API/wire/DB/shared-schema change.
- TypeScript strict. Every user-facing string via `t("paywalls.builder.canvas.*", "English fallback")`, matching the existing `paywalls.builder.canvas.*` keys.
- Commerce preview (`packageList`/`purchaseButton`/CTA) is **unchanged** — it keeps the current placeholder/`{{variable}}` rendering (prices are store-side, not server-knowable). The existing "Preview — placeholder prices" badge stays; no new banner (YAGNI).
- Do NOT touch funnel-builder. Its generic frames stay; P1's catalog is paywall-builder-local.
- Ephemeral canvas UI state is never persisted server-side — no migration.
- **No magic values.** Hoist meaningful literals (style dimensions, scales, z-index layers, thresholds) into named constants near the top of the module. Structured data tables (e.g. the device catalog's `w`/`h`/`safeTop` fields) are NOT magic values.
- **Stay on the current branch (`main`).** No branches, no worktrees.
- Tests run with `pnpm --filter @rovenue/dashboard exec vitest run <path>` (no bare `vitest` script). Typecheck: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`. Build: `pnpm --filter @rovenue/dashboard build`.
- Conventional commits; commit per task.

---

## File Structure

**Create:**
- `apps/dashboard/src/components/paywall-builder/device-catalog.ts` — device specs + `devicesForPlatform` / `deviceById` helpers.
- `apps/dashboard/src/components/paywall-builder/device-catalog.test.ts` — helper unit tests.
- `apps/dashboard/src/components/paywall-builder/device-frame.tsx` — one device frame (chassis, status bar, notch, inset content, optional safe-area overlay).

**Modify:**
- `apps/dashboard/src/components/paywall-builder/types.ts` — `CanvasDevice` → catalog device id (`string`).
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts` — canvas device/platform/toggle state.
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts` — new canvas-state tests.
- `apps/dashboard/src/components/paywall-builder/canvas.tsx` — use the catalog + `DeviceFrame`; single + all-sizes; canvas-bar controls.
- `apps/dashboard/src/components/paywall-builder/top-bar.tsx` — remove the phone/tablet/desktop device switcher + now-unused imports.

---

### Task 1: Device catalog + helpers

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/device-catalog.ts`
- Create: `apps/dashboard/src/components/paywall-builder/device-catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DevicePlatform = "ios" | "android"`
  - `type DeviceNotch = "dynamic-island" | "punch-hole" | "none"`
  - `interface CanvasDeviceSpec { id: string; platform: DevicePlatform; label: string; w: number; h: number; safeTop: number; safeBottom: number; notch: DeviceNotch }`
  - `const CANVAS_DEVICES: readonly CanvasDeviceSpec[]`
  - `const DEFAULT_DEVICE_ID = "iphone15"`
  - `function devicesForPlatform(p: DevicePlatform): CanvasDeviceSpec[]`
  - `function deviceById(id: string): CanvasDeviceSpec` (unknown id → the `DEFAULT_DEVICE_ID` spec)

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/paywall-builder/device-catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CANVAS_DEVICES,
  DEFAULT_DEVICE_ID,
  deviceById,
  devicesForPlatform,
} from "./device-catalog";

describe("device-catalog", () => {
  it("catalog carries the four spec devices with accurate frame data", () => {
    const byId = Object.fromEntries(CANVAS_DEVICES.map((d) => [d.id, d]));
    expect(byId.iphone15).toMatchObject({
      platform: "ios",
      w: 393,
      h: 852,
      safeTop: 59,
      safeBottom: 34,
      notch: "dynamic-island",
    });
    expect(byId.iphonese).toMatchObject({ platform: "ios", w: 375, h: 667, safeBottom: 0, notch: "none" });
    expect(byId.pixel8).toMatchObject({ platform: "android", w: 412, h: 915, notch: "punch-hole" });
    expect(byId.galaxya).toMatchObject({ platform: "android", w: 360, h: 800 });
  });

  it("devicesForPlatform filters and preserves catalog order", () => {
    expect(devicesForPlatform("ios").map((d) => d.id)).toEqual(["iphone15", "iphonese"]);
    expect(devicesForPlatform("android").map((d) => d.id)).toEqual(["pixel8", "galaxya"]);
  });

  it("deviceById returns the match", () => {
    expect(deviceById("pixel8").label).toBe("Pixel 8");
  });

  it("deviceById falls back to the default for an unknown id", () => {
    expect(deviceById("nope").id).toBe(DEFAULT_DEVICE_ID);
    expect(deviceById("").id).toBe(DEFAULT_DEVICE_ID);
  });

  it("DEFAULT_DEVICE_ID is a real catalog entry", () => {
    expect(CANVAS_DEVICES.some((d) => d.id === DEFAULT_DEVICE_ID)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/device-catalog.test.ts`
Expected: FAIL — `Cannot find module './device-catalog'`.

- [ ] **Step 3: Write the module**

Create `apps/dashboard/src/components/paywall-builder/device-catalog.ts`:

```ts
// =============================================================
// Canvas device catalog — accurate per-device frame data for the
// paywall builder preview. Pure data + two lookups. Values mirror the
// design mock's PB_DEVICES. Paywall-builder-local (funnels keep their
// generic frames); extend by adding a CanvasDeviceSpec entry.
// =============================================================

export type DevicePlatform = "ios" | "android";
export type DeviceNotch = "dynamic-island" | "punch-hole" | "none";

export interface CanvasDeviceSpec {
  id: string;
  platform: DevicePlatform;
  label: string;
  /** Logical points, portrait. */
  w: number;
  h: number;
  /** Status-bar / notch inset. */
  safeTop: number;
  /** Home-indicator / gesture-bar inset (0 on devices without one). */
  safeBottom: number;
  notch: DeviceNotch;
}

export const CANVAS_DEVICES: readonly CanvasDeviceSpec[] = [
  { id: "iphone15", platform: "ios", label: "iPhone 15 Pro", w: 393, h: 852, safeTop: 59, safeBottom: 34, notch: "dynamic-island" },
  { id: "iphonese", platform: "ios", label: "iPhone SE", w: 375, h: 667, safeTop: 20, safeBottom: 0, notch: "none" },
  { id: "pixel8", platform: "android", label: "Pixel 8", w: 412, h: 915, safeTop: 40, safeBottom: 24, notch: "punch-hole" },
  { id: "galaxya", platform: "android", label: "Galaxy A54", w: 360, h: 800, safeTop: 32, safeBottom: 24, notch: "punch-hole" },
];

export const DEFAULT_DEVICE_ID = "iphone15";

/** Devices for a platform, in catalog order. */
export function devicesForPlatform(p: DevicePlatform): CanvasDeviceSpec[] {
  return CANVAS_DEVICES.filter((d) => d.platform === p);
}

/** Lookup by id; an unknown id resolves to the default device's spec so
 * callers never have to null-check a device. */
export function deviceById(id: string): CanvasDeviceSpec {
  return (
    CANVAS_DEVICES.find((d) => d.id === id) ??
    CANVAS_DEVICES.find((d) => d.id === DEFAULT_DEVICE_ID)!
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/device-catalog.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/device-catalog.ts \
  apps/dashboard/src/components/paywall-builder/device-catalog.test.ts
git commit -m "feat(dashboard): paywall canvas device catalog + lookups"
```

---

### Task 2: View-model canvas device/platform/toggle state

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/types.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`

**Interfaces:**
- Consumes: `DevicePlatform`, `devicesForPlatform`, `deviceById`, `DEFAULT_DEVICE_ID` (Task 1).
- Produces on `PaywallBuilderViewModel`: `canvasDevice: string` (a catalog id, default `"iphone15"`), `@derived get canvasPlatform(): DevicePlatform`, `showSafeArea: boolean`, `showAllSizes: boolean`, `setCanvasDevice(id: string)`, `setCanvasPlatform(p: DevicePlatform)`, `toggleSafeArea()`, `setSafeArea(v: boolean)`, `toggleAllSizes()`, `setAllSizes(v: boolean)`.

- [ ] **Step 1: Redefine the `CanvasDevice` type**

In `apps/dashboard/src/components/paywall-builder/types.ts`, replace the `CanvasDevice` union:

```ts
/** Canvas preview device — a catalog id from `device-catalog.ts`. */
export type CanvasDevice = string;
```

(Keep `ColorScheme` unchanged.)

- [ ] **Step 2: Write the failing VM tests**

Append to `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts` (inside the top-level `describe("PaywallBuilderViewModel", …)`, e.g. after the existing state tests). It reuses the file's existing `makeVm` helper — canvas state needs no server load, so `makeVm({})` is enough:

```ts
  describe("canvas device state", () => {
    it("defaults to the iPhone 15 Pro and derives its platform", () => {
      const vm = makeVm({});
      expect(vm.canvasDevice).toBe("iphone15");
      expect(vm.canvasPlatform).toBe("ios");
      expect(vm.showSafeArea).toBe(false);
      expect(vm.showAllSizes).toBe(false);
    });

    it("setCanvasDevice updates the id and the derived platform", () => {
      const vm = makeVm({});
      vm.setCanvasDevice("pixel8");
      expect(vm.canvasDevice).toBe("pixel8");
      expect(vm.canvasPlatform).toBe("android");
    });

    it("setCanvasPlatform lands on that platform's first device", () => {
      const vm = makeVm({});
      vm.setCanvasPlatform("android");
      expect(vm.canvasDevice).toBe("pixel8");
      expect(vm.canvasPlatform).toBe("android");
      vm.setCanvasPlatform("ios");
      expect(vm.canvasDevice).toBe("iphone15");
    });

    it("toggles safe-area and all-sizes", () => {
      const vm = makeVm({});
      vm.toggleSafeArea();
      expect(vm.showSafeArea).toBe(true);
      vm.setSafeArea(false);
      expect(vm.showSafeArea).toBe(false);
      vm.toggleAllSizes();
      expect(vm.showAllSizes).toBe(true);
      vm.setAllSizes(false);
      expect(vm.showAllSizes).toBe(false);
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/vm/paywall-builder.vm.test.ts -t "canvas device state"`
Expected: FAIL — `vm.canvasPlatform` / `vm.setCanvasPlatform` / `vm.showSafeArea` undefined, and `canvasDevice` is `"phone"` not `"iphone15"`.

- [ ] **Step 4: Implement the VM state**

In `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`:

Add to the imports from `../types` (or a new import) the catalog helpers:

```ts
import type { CanvasDevice, ColorScheme } from "../types";
import {
  DEFAULT_DEVICE_ID,
  deviceById,
  devicesForPlatform,
  type DevicePlatform,
} from "../device-catalog";
```

Replace the `canvasDevice` field default and `setCanvasDevice`, and add the new state + derived + setters. The existing block reads:

```ts
  @state canvasDevice: CanvasDevice = "phone";
  @state canvasZoom = 1;
```

Change it to:

```ts
  @state canvasDevice: CanvasDevice = DEFAULT_DEVICE_ID;
  @state showSafeArea = false;
  @state showAllSizes = false;
  @state canvasZoom = 1;
```

Then replace `setCanvasDevice` and add the new methods (keep `setCanvasZoom`/`zoomStep`/`resetCanvasZoom`/`handleCanvasWheel` as-is):

```ts
  setCanvasDevice(id: string) {
    this.canvasDevice = id;
  }
  /** The platform of the currently-previewed device. */
  @derived get canvasPlatform(): DevicePlatform {
    return deviceById(this.canvasDevice).platform;
  }
  /** Switch platforms by selecting that platform's first catalog device,
   * so the platform segment and device picker stay consistent. */
  setCanvasPlatform(p: DevicePlatform) {
    const first = devicesForPlatform(p)[0];
    if (first) this.canvasDevice = first.id;
  }
  toggleSafeArea() {
    this.showSafeArea = !this.showSafeArea;
  }
  setSafeArea(v: boolean) {
    this.showSafeArea = v;
  }
  toggleAllSizes() {
    this.showAllSizes = !this.showAllSizes;
  }
  setAllSizes(v: boolean) {
    this.showAllSizes = v;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/vm/paywall-builder.vm.test.ts`
Expected: PASS — the whole VM suite, including the 4 new canvas tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: exits 0. Note: `top-bar.tsx`'s `DEVICES` const still lists `"phone"/"tablet"/"desktop"` — these remain valid `string` values under the new `CanvasDevice = string`, so the top bar still compiles (it's removed in Task 5). `deviceById("phone")` falls back to the default, so the stale switcher is harmless until then.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/types.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts
git commit -m "feat(dashboard): paywall canvas device/platform/toggle view-model state"
```

---

### Task 3: `DeviceFrame` component + single-device canvas rendering

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/device-frame.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/canvas.tsx`

**Interfaces:**
- Consumes: `CanvasDeviceSpec`, `deviceById` (Task 1); `vm.canvasDevice`, `vm.canvasZoom`, `vm.colorScheme`, `vm.showSafeArea` (Task 2).
- Produces: `DeviceFrame` component —
  `function DeviceFrame(props: { spec: CanvasDeviceSpec; scale: number; scheme: "light" | "dark"; showSafeArea: boolean; label?: boolean; children: React.ReactNode }): JSX.Element`.
  Renders the chassis at `spec.w × spec.h` scaled by `scale`, a status bar of height `spec.safeTop`, the notch per `spec.notch`, a content area inset by `safeTop`/`safeBottom` holding `children`, and (when `showSafeArea`) inset guide bands.

- [ ] **Step 1: Write the `DeviceFrame` component**

Create `apps/dashboard/src/components/paywall-builder/device-frame.tsx`:

```tsx
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
```

- [ ] **Step 2: Rewire `canvas.tsx` single-device rendering to use `DeviceFrame`**

In `apps/dashboard/src/components/paywall-builder/canvas.tsx`:

Replace the imports line for lucide (keep only what's still used — the zoom bar uses `Maximize`, `Minus`, `Plus`; `Monitor`/`Smartphone`/`Tablet` were only for `DEVICE_FRAMES`) and add the catalog + frame imports:

```tsx
import { Maximize, Minus, Plus } from "lucide-react";
```
```tsx
import { deviceById } from "./device-catalog";
import { DeviceFrame } from "./device-frame";
```

Delete the entire `DEVICE_FRAMES` constant (lines 21–46) and the now-unused `import type { CanvasDevice } from "./types";`.

Replace the render block that currently reads:

```tsx
  const device = vm.canvasDevice;
  const zoom = vm.canvasZoom;
  const frame = DEVICE_FRAMES[device];
```

with:

```tsx
  const zoom = vm.canvasZoom;
  const spec = deviceById(vm.canvasDevice);
```

Then replace the inner frame markup — the block from `<div style={{ transform: \`scale(${zoom})\` … }}>` through its matching close (the `frame.outer`/`frame.screen`/`frame.notch` block, currently lines 233–260) — with a `DeviceFrame` mounting the existing `PaywallRenderer` unchanged:

```tsx
        <DeviceFrame spec={spec} scale={zoom} scheme={vm.colorScheme} showSafeArea={vm.showSafeArea}>
          <div onClick={handleClick} className="min-h-full">
            <PaywallRenderer
              key={rendererKey}
              config={vm.config}
              offering={offering}
              locale={vm.editLocale}
              colorScheme={vm.colorScheme}
              priceView={priceView}
              eligibility={eligibility}
              onPurchase={noop}
              onClose={noop}
              onRestore={noop}
              onUrl={noop}
            />
          </div>
        </DeviceFrame>
```

Leave the selection-ring block (`{ring && …}`) and the `viewportRef`/wheel/ring `useLayoutEffect`s unchanged — they measure real DOM rects and still work against the new frame. The ring recompute already depends on `vm.canvasZoom` and `vm.canvasDevice` (line 168), which still change.

- [ ] **Step 3: Typecheck and build**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit && pnpm --filter @rovenue/dashboard build`
Expected: both exit 0. If `tsc` flags `Smartphone`/`Tablet`/`Monitor` or `CanvasDevice` as unused imports in `canvas.tsx`, remove them.

- [ ] **Step 4: Run the paywall-builder suite (no regressions)**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`
Expected: PASS — all existing tests plus Task 1/2's new tests.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/device-frame.tsx \
  apps/dashboard/src/components/paywall-builder/canvas.tsx
git commit -m "feat(dashboard): render the paywall canvas in accurate device frames"
```

---

### Task 4: Canvas-bar controls + all-sizes grid

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/canvas.tsx`

**Interfaces:**
- Consumes: `CANVAS_DEVICES`, `devicesForPlatform`, `deviceById` (Task 1); `vm.canvasPlatform`, `vm.setCanvasPlatform`, `vm.setCanvasDevice`, `vm.showAllSizes`, `vm.toggleAllSizes`, `vm.showSafeArea`, `vm.toggleSafeArea` (Task 2); `DeviceFrame` (Task 3).
- Produces: the canvas bar's platform segment + device dropdown + all-sizes/safe-area chips; all-sizes grid rendering.

- [ ] **Step 1: Add the constants + local dropdown state**

In `canvas.tsx`, add to the catalog import: `devicesForPlatform`. Add `useState` for the device dropdown (the file already imports `useState`):

```tsx
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
```

Add a fixed multi-scale constant near `ZOOM_STEPS` (single-device keeps using the live `vm.canvasZoom`; all-sizes uses this fixed scale):

```tsx
const ALL_SIZES_SCALE = 0.64;
```

- [ ] **Step 2: Add the canvas-bar controls**

In the canvas bar (`<div className="flex items-center gap-2 border-b …">`), after the zoom group and the `Maximize` fit button, and before the `ml-auto` badge, insert the platform segment, device dropdown, and the two chips:

```tsx
        <div className="mx-1 h-5 w-px bg-rv-divider" />

        {/* platform segment */}
        <div className="inline-flex rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {(["ios", "android"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => vm.setCanvasPlatform(p)}
              className={cn(
                "cursor-pointer rounded px-2 py-1 text-[11px] font-medium capitalize transition",
                vm.canvasPlatform === p ? "bg-rv-c4 text-foreground" : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {p === "ios"
                ? t("paywalls.builder.canvas.platformIos", "iOS")
                : t("paywalls.builder.canvas.platformAndroid", "Android")}
            </button>
          ))}
        </div>

        {/* device dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setDeviceMenuOpen((o) => !o)}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[11px] text-foreground transition hover:bg-rv-c3"
          >
            {deviceById(vm.canvasDevice).label}
            <span className="font-rv-mono text-[10px] text-rv-mute-500">
              {deviceById(vm.canvasDevice).w}×{deviceById(vm.canvasDevice).h}
            </span>
          </button>
          {deviceMenuOpen && (
            <>
              <div className="fixed inset-0 z-[49]" onClick={() => setDeviceMenuOpen(false)} />
              <div className="absolute left-0 top-full z-50 mt-1 w-[220px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
                <div className="mb-1 px-1.5 py-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                  {t("paywalls.builder.canvas.devices", "{{platform}} devices", { platform: vm.canvasPlatform })}
                </div>
                {devicesForPlatform(vm.canvasPlatform).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      vm.setCanvasDevice(d.id);
                      vm.setAllSizes(false);
                      setDeviceMenuOpen(false);
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12px]",
                      d.id === vm.canvasDevice ? "bg-rv-c2 text-foreground" : "text-foreground hover:bg-rv-c2",
                    )}
                  >
                    <span>{d.label}</span>
                    <span className="font-rv-mono text-[10px] text-rv-mute-500">{d.w}×{d.h}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* all-sizes + safe-area chips */}
        <button
          type="button"
          onClick={() => vm.toggleAllSizes()}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition",
            vm.showAllSizes
              ? "border-rv-accent-500/40 bg-rv-accent-500/10 text-rv-accent-500"
              : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:bg-rv-c3 hover:text-foreground",
          )}
        >
          {t("paywalls.builder.canvas.allSizes", "All sizes")}
        </button>
        <button
          type="button"
          onClick={() => vm.toggleSafeArea()}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition",
            vm.showSafeArea
              ? "border-rv-accent-500/40 bg-rv-accent-500/10 text-rv-accent-500"
              : "border-rv-divider bg-rv-c2 text-rv-mute-600 hover:bg-rv-c3 hover:text-foreground",
          )}
        >
          {t("paywalls.builder.canvas.safeArea", "Safe area")}
        </button>
```

- [ ] **Step 3: Render the all-sizes grid**

Wrap the stage so that when `vm.showAllSizes` is true it renders every device for the platform, else the single zoomed device. Replace the single-device stage wrapper (the `<div style={{ transform: \`scale(${zoom})\` … }}>` … `</div>` that now wraps `DeviceFrame`) with a conditional. The all-sizes branch renders a scrolling row of `DeviceFrame`s at `ALL_SIZES_SCALE`, each with `label`; each mounts its OWN `PaywallRenderer` (same props). Factor the renderer into a small local element to avoid duplication:

```tsx
  const renderPaywall = (
    <div onClick={handleClick} className="min-h-full">
      <PaywallRenderer
        key={rendererKey}
        config={vm.config}
        offering={offering}
        locale={vm.editLocale}
        colorScheme={vm.colorScheme}
        priceView={priceView}
        eligibility={eligibility}
        onPurchase={noop}
        onClose={noop}
        onRestore={noop}
        onUrl={noop}
      />
    </div>
  );
```

Single-device branch (uses `renderPaywall`):

```tsx
        {!vm.showAllSizes && (
          <DeviceFrame spec={spec} scale={zoom} scheme={vm.colorScheme} showSafeArea={vm.showSafeArea}>
            {renderPaywall}
          </DeviceFrame>
        )}
```

All-sizes branch:

```tsx
        {vm.showAllSizes && (
          <div className="flex items-start gap-6">
            {devicesForPlatform(vm.canvasPlatform).map((d) => (
              <DeviceFrame
                key={d.id}
                spec={d}
                scale={ALL_SIZES_SCALE}
                scheme={vm.colorScheme}
                showSafeArea={vm.showSafeArea}
                label
              >
                {renderPaywall}
              </DeviceFrame>
            ))}
          </div>
        )}
```

Note: React reuses the single `renderPaywall` element reference across frames in the map — because each `DeviceFrame` is a distinct parent, React mounts an independent renderer instance per frame, which is what we want (each device previews independently). Keep the `rendererKey` remount behaviour.

Disable the zoom buttons while `showAllSizes` (all-sizes uses the fixed scale). In the zoom-out/in/reset buttons, add `disabled={vm.showAllSizes || …}` to the existing `disabled` expressions, e.g.:

```tsx
            disabled={vm.showAllSizes || zoom === ZOOM_STEPS[0]}
```
```tsx
            disabled={vm.showAllSizes || zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
```

(The reset `%` button and `Maximize` fit button may stay enabled; they no-op meaningfully in all-sizes since zoom is ignored — or add `disabled={vm.showAllSizes}` to them too for clarity.)

- [ ] **Step 4: Typecheck, build, and run the suite**

Run:
```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
pnpm --filter @rovenue/dashboard build
pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder
```
Expected: all exit 0 / PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/canvas.tsx
git commit -m "feat(dashboard): paywall canvas-bar device/platform pickers + all-sizes grid"
```

---

### Task 5: Remove the top-bar device switcher

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/top-bar.tsx`

**Interfaces:**
- Consumes: nothing new. Device/platform selection now lives on the canvas bar (Task 4).
- Produces: a top bar without the phone/tablet/desktop switcher.

- [ ] **Step 1: Remove the switcher and its data**

In `apps/dashboard/src/components/paywall-builder/top-bar.tsx`:

Delete the `DEVICES` constant (the `const DEVICES: ReadonlyArray<…> = [ … ]` block).

Delete the device-switcher markup — the block:

```tsx
        <div className="inline-flex rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {DEVICES.map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => vm.setCanvasDevice(value)}
              title={t(`paywalls.builder.topbar.device${label}`, label)}
              className={cn(
                "flex h-6 w-7 cursor-pointer items-center justify-center rounded transition",
                vm.canvasDevice === value ? "bg-rv-c4 text-foreground" : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
```

If removing it leaves an adjacent divider (`<div className="mx-0.5 h-5 w-px bg-rv-divider" />`) doubled or dangling, remove the now-redundant one so the top bar spacing stays clean.

Remove the now-unused imports: `Monitor`, `Smartphone`, `Tablet` from the `lucide-react` import, and `import type { CanvasDevice } from "./types";` if `CanvasDevice` is no longer referenced in the file.

- [ ] **Step 2: Typecheck and build**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit && pnpm --filter @rovenue/dashboard build`
Expected: both exit 0 (a leftover unused import is the likely failure — remove it).

- [ ] **Step 3: Run the paywall-builder suite**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/top-bar.tsx
git commit -m "feat(dashboard): move paywall device selection off the top bar to the canvas"
```

---

## Post-implementation verification

1. `pnpm --filter @rovenue/dashboard exec tsc --noEmit` — clean.
2. `pnpm --filter @rovenue/dashboard build` — succeeds.
3. `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` — all green (device-catalog + VM canvas tests + the pre-existing suite).
4. Manual (optional, against a seeded dev dashboard): open a paywall in the builder; confirm iPhone 15 Pro renders a dynamic-island frame with a sticky footer above the home indicator; toggle Safe area to see the inset bands; switch to Android → Pixel 8; toggle All sizes to see both platform devices side by side; zoom works in single mode and is disabled in all-sizes.

## Out of scope (deferred)

- Real resolved prices / `GET /offerings/:id/resolved` → P6 (products carry no server-side price/period/trial; store-side only).
- Sharing the device catalog with funnel-builder → later, if wanted.
- New node types, inspector tabs, localization matrix, etc. → their own phases.
