// `requireNativeViewManager` — NOT `requireNativeView`, which does not
// exist in expo-modules-core 2.5.0. This is the only view accessor the
// package exports (build/index.d.ts:11) and it is documented as a drop-in
// replacement for RN's `requireNativeComponent`, which is why events
// arrive wrapped in `nativeEvent`.
import { requireNativeViewManager } from "expo-modules-core";

/** Wire props for the native paywall view. Deliberately narrower than
 *  `RovenuePaywallViewProps`: the paywall itself does not cross the
 *  bridge, only the identifier the native side re-resolves it with. */
export type NativePaywallViewProps = {
  placementIdentifier: string;
  locale?: string;
  colorSchemeOverride?: "light" | "dark";
  hasRestoreHandler: boolean;
  hasUrlHandler: boolean;
  onPurchaseCompleted: (event: { nativeEvent: { result: unknown } }) => void;
  onPurchaseFailed: (event: { nativeEvent: { code: string; message: string } }) => void;
  onCloseRequested: (event: { nativeEvent: Record<string, never> }) => void;
  onRestoreRequested: (event: { nativeEvent: Record<string, never> }) => void;
  onUrlRequested: (event: { nativeEvent: { url: string } }) => void;
  style?: unknown;
};

const MODULE_NAME = "Rovenue";

// No view name: both native modules register the paywall as the module's
// single default view (`View(RovenuePaywallExpoView.self) { … }` with no
// name argument), so the manager is looked up by module name alone.
export const NativePaywallView =
  requireNativeViewManager<NativePaywallViewProps>(MODULE_NAME);
