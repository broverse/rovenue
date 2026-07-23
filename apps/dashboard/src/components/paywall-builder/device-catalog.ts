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
