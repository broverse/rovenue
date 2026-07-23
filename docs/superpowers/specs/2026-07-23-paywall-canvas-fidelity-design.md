# Paywall Builder — Canvas Fidelity (P1) Design

**Date:** 2026-07-23
**Status:** Approved design. Feeds a writing-plans implementation plan.
**Phase:** P1 of the paywall-builder redesign (`docs/superpowers/specs/2026-07-23-paywall-builder-gap-analysis.md` §7). P0 shipped; P4a was already done in Phase D (struck).
**Design source:** Claude Design project `008cf05d-86d0-4f88-bf69-3802297259d1` — `Rovenue Paywall Builder.html` (canvas stage, `PB_DEVICES`, safe-area overlay, all-sizes grid, canvas bar).

---

## 1. Goal & scope

Make the builder's canvas render paywalls in **accurate per-device frames** — real pixel dimensions, correct safe-area insets, and the right notch/cutout per device — with a **safe-area overlay**, an **"all sizes"** grid, and a **per-platform device picker**. Purely a dashboard preview upgrade.

**In scope:** a device catalog (4 devices, 2 platforms); the canvas rendering the selected device's frame (status bar, notch, safe-area-respecting content area); a safe-area guide overlay; an all-sizes grid; canvas-bar controls (platform, device, all-sizes, safe-area) alongside the existing zoom.

**Explicitly OUT of scope (decided during brainstorming):**
- **Real prices in the commerce preview.** Rovenue's `products` table has no price/period/trial/currency — those live in App Store Connect / Play Console and are hydrated on-device by the SDK (enriched StoreProduct). The server cannot resolve them, so `GET /offerings/:id/resolved` (gap-analysis §6.11) **cannot be built server-side** and is struck from P1. The canvas commerce nodes (`packageList`, `purchaseButton`, CTA) keep their current placeholder / `{{variable}}` rendering unchanged. The resolved-catalog question (author-supplied *preview metadata* vs. store-API fetch) is deferred to **P6** (commerce binding UX), where the resolved readout actually matters.
- **No new API, no wire change, no DB migration, no shared-schema change.** Every change is in `apps/dashboard/src/components/paywall-builder/`.
- **No sharing with funnel-builder.** Both builders currently use the same generic `phone|tablet|desktop` CSS frame (`canvas.tsx` / `funnel-builder/canvas-editor.tsx`) with a single `notch: boolean`. Neither has a real device catalog. P1's catalog is paywall-builder-local; funnels can adopt it later (YAGNI — not now).

**Success criteria:** selecting iPhone 15 Pro shows a 393×852 frame with a dynamic-island and 59/34 safe insets; a `StickyFooter` sits above the home-indicator inset; the safe-area toggle draws the inset guides; "all sizes" shows every device for the current platform; the platform segment switches the device set; zoom still works; `tsc` + `build` green; new VM state + the safe-area helper are unit-tested.

---

## 2. Current state (what P1 changes)

- `apps/dashboard/src/components/paywall-builder/types.ts` — `CanvasDevice = "phone" | "tablet" | "desktop"`.
- `canvas.tsx` (272 lines) — `DEVICE_FRAMES` (3 generic CSS frames, `notch: boolean`), zoom bar, renders the paywall inside `frame.outer`/`frame.screen`, a generic notch bar. No real dimensions, no safe area, no status bar content, no all-sizes.
- `vm/paywall-builder.vm.ts` — canvas state: `canvasDevice: CanvasDevice`, `canvasZoom`, `ZOOM_STEPS`, `setCanvasDevice(d)`, `setCanvasZoom(z)`, `zoomStep(dir)`, `resetCanvasZoom()`, `handleCanvasWheel(deltaY, isPinch)`.
- `top-bar.tsx` — a `DEVICES` const (phone/tablet/desktop) + a 3-button device switcher calling `vm.setCanvasDevice`; plus the scheme toggle and `LocaleSwitcher` (kept).

---

## 3. Device catalog

New pure-data module `apps/dashboard/src/components/paywall-builder/device-catalog.ts`:

```ts
export type DevicePlatform = "ios" | "android";
export type DeviceNotch = "dynamic-island" | "punch-hole" | "none";

export interface CanvasDeviceSpec {
  id: string;              // stable id, e.g. "iphone15"
  platform: DevicePlatform;
  label: string;           // "iPhone 15 Pro"
  w: number;               // logical points, portrait
  h: number;
  safeTop: number;         // status-bar / notch inset
  safeBottom: number;      // home-indicator / gesture-bar inset
  notch: DeviceNotch;
}

export const CANVAS_DEVICES: readonly CanvasDeviceSpec[] = [
  { id: "iphone15", platform: "ios",     label: "iPhone 15 Pro", w: 393, h: 852, safeTop: 59, safeBottom: 34, notch: "dynamic-island" },
  { id: "iphonese", platform: "ios",     label: "iPhone SE",     w: 375, h: 667, safeTop: 20, safeBottom: 0,  notch: "none" },
  { id: "pixel8",   platform: "android", label: "Pixel 8",       w: 412, h: 915, safeTop: 40, safeBottom: 24, notch: "punch-hole" },
  { id: "galaxya",  platform: "android", label: "Galaxy A54",    w: 360, h: 800, safeTop: 32, safeBottom: 24, notch: "punch-hole" },
];

export const DEFAULT_DEVICE_ID = "iphone15";

/** Devices for a platform, in catalog order. */
export function devicesForPlatform(p: DevicePlatform): CanvasDeviceSpec[];
/** Lookup by id; falls back to DEFAULT_DEVICE_ID's spec if unknown. */
export function deviceById(id: string): CanvasDeviceSpec;
```

Values mirror the design mock's `PB_DEVICES`. The two helpers are pure and unit-tested.

---

## 4. VM state changes

Redefine `CanvasDevice` in `types.ts` from the 3-value union to `type CanvasDevice = string` (a catalog device id). Keeping the alias (rather than deleting it and using a bare `string`) minimises import churn — `top-bar.tsx` and `canvas.tsx` already import `CanvasDevice`, and the VM's `canvasDevice` field keeps its type name. The VM gains:

- `canvasDevice: string` — a device id, default `DEFAULT_DEVICE_ID`. (Ephemeral UI state, never persisted server-side, so no migration.)
- `@derived get canvasPlatform(): DevicePlatform` — `deviceById(this.canvasDevice).platform`.
- `showSafeArea: boolean = false`, `showAllSizes: boolean = false`.
- `setCanvasDevice(id: string)` — sets the id; if the new device's platform differs, that's fine (device carries platform).
- `setCanvasPlatform(p: DevicePlatform)` — switches to that platform's first device (`devicesForPlatform(p)[0].id`), so the picker and platform segment stay consistent.
- `toggleSafeArea()`, `setSafeArea(v)`, `toggleAllSizes()`, `setAllSizes(v)`.
- Zoom state unchanged. When `showAllSizes` is true the canvas uses a fixed multi-scale (see §5), independent of `canvasZoom`.

All new setters/derived are covered by VM unit tests (mirroring the existing `setColorScheme`/`setCanvasDevice` tests).

---

## 5. Canvas rendering

Rework `canvas.tsx` (and extract sub-components as it grows — keep each focused):

**Single-device mode** (`showAllSizes === false`):
- Render one `DeviceFrame` for `deviceById(canvasDevice)` at `w × h` logical points, scaled by `canvasZoom` (`transform: scale(zoom)`).
- **Status bar:** a `safeTop`-tall bar showing `9:41` and platform glyphs (iOS vs Android styling), matching the mock. Light/dark per the existing `vm.colorScheme`.
- **Notch:** overlay per `notch` — a centered pill for `dynamic-island`, a small circle for `punch-hole`, nothing for `none`.
- **Content area:** the paywall renders in the area below the status bar; the content container applies `paddingTop: safeTop` / `paddingBottom: safeBottom` (scaled) so a `StickyFooter` sits above the home-indicator inset — the same inset the SDK applies on device. The existing `@rovenue/paywall-renderer` mount is unchanged; only the wrapper's insets change.
- **Safe-area overlay** (`showSafeArea === true`): translucent guide bands over the top `safeTop` and bottom `safeBottom` regions, each labelled (e.g. "safe top 59"), matching the mock. Purely an overlay — does not alter layout.

**All-sizes mode** (`showAllSizes === true`):
- Render every device from `devicesForPlatform(canvasPlatform)` side by side in a horizontally-scrolling row, each at a fixed multi-scale (~0.64, vs ~0.82 nominal single — final constants pinned in the plan), each with its own frame + label. Selection/hover still work per frame. Zoom controls are disabled (or hidden) in this mode.

**Safe-area inset math** is a pure helper (e.g. `frameInsets(spec, zoom) → { top, bottom }` in points) with a unit test — the one piece of non-trivial logic worth isolating.

Decompose: `device-frame.tsx` (one frame: chassis + status bar + notch + inset content + optional overlay), `canvas.tsx` (the stage: single vs all-sizes layout, zoom, click-to-deselect), `device-catalog.ts` (data + helpers). This keeps `canvas.tsx` from ballooning.

---

## 6. Control surface

**Canvas bar** (where the zoom controls already live) gains, left-to-right:
- a **platform segment** (iOS / Android) → `vm.setCanvasPlatform`;
- a **device dropdown** (label + `w×h`) over `devicesForPlatform(canvasPlatform)` → `vm.setCanvasDevice`, using the same dropdown idiom as the top-bar's `LocaleSwitcher` (fixed-inset backdrop + absolute panel);
- an **"All sizes"** toggle chip → `vm.toggleAllSizes`;
- a **"Safe area"** toggle chip → `vm.toggleSafeArea`;
- the existing **zoom** controls (disabled in all-sizes mode).

**Top bar:** **remove** the phone/tablet/desktop device switcher (`DEVICES` const + its buttons) — device/platform selection now lives on the canvas bar, matching the mock and decluttering the top bar (already busy with the Task 11 publish group). The scheme toggle and `LocaleSwitcher` **stay** in the top bar; the canvas does not duplicate them.

All new strings go through `t("paywalls.builder.canvas.*", "English fallback")`.

---

## 7. Testing

- **`device-catalog.ts`** — unit-test `devicesForPlatform` (filters + order) and `deviceById` (hit + unknown→default fallback).
- **Safe-area inset helper** — unit-test `frameInsets` at zoom 1 and a fractional zoom, both platforms incl. `safeBottom: 0` (iPhone SE).
- **VM** — unit-test `setCanvasDevice`, `setCanvasPlatform` (lands on the platform's first device), `canvasPlatform` derived, and the safe-area/all-sizes toggles.
- **Presentational** (`device-frame.tsx`, `canvas.tsx`) — verified by `tsc --noEmit` + `pnpm --filter @rovenue/dashboard build`, plus the existing paywall-builder test suite staying green. No new render tests unless a specific interaction (e.g. all-sizes selection) warrants one.

Run tests with `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder` (packages have no bare `vitest` script).

---

## 8. Risks & non-issues

- **`CanvasDevice` type migration** touches `types.ts`, the VM, `canvas.tsx`, and `top-bar.tsx` together. It's a compile-time-caught change (a string id replacing a 3-value union); `tsc` guides the edits. Ephemeral state → no persistence migration.
- **Commerce preview looks price-less.** Intentional and correct (prices are store-side). Deferred to P6. No banner in P1 (YAGNI).
- **Funnel divergence.** Funnels keep their generic frames; P1 does not touch them. Acceptable — the two builders' "shared visual language" comment in `canvas.tsx` becomes slightly stale, which the plan will note.
