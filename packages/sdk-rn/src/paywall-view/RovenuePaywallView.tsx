import { StyleSheet } from "react-native";
import { mapNativeError } from "../errors";
import type { Paywall, PurchaseResult } from "../types";
import { NativePaywallView } from "./native-view";

// The paywall fills whatever frame the host gives it; hosts size it with
// their own flex container. There is deliberately no `style` prop — the
// public props contract is preserved byte-for-byte from the JS renderer
// this replaced.
const styles = StyleSheet.create({ fill: { flex: 1 } });

export type RovenuePaywallViewProps = {
  paywall: Paywall;
  locale?: string;
  colorScheme?: "light" | "dark";
  onPurchaseCompleted?: (result: PurchaseResult) => void;
  onPurchaseFailed?: (error: unknown) => void;
  onClose?: () => void;
  /** Omit to HIDE restore buttons entirely (e.g. funnel-like contexts). */
  onRestore?: () => void;
  /** The renderer never navigates itself — scheme-check before opening. */
  onUrl?: (url: string) => void;
};

export function RovenuePaywallView(props: RovenuePaywallViewProps) {
  const { paywall, locale, colorScheme, onPurchaseCompleted, onPurchaseFailed, onClose, onRestore, onUrl } = props;
  return (
    <NativePaywallView
      style={styles.fill}
      placementIdentifier={paywall.placementIdentifier}
      locale={locale}
      colorSchemeOverride={colorScheme}
      // The native views branch on whether a handler EXISTS, so this is a
      // value, not a convenience flag.
      hasRestoreHandler={onRestore !== undefined}
      hasUrlHandler={onUrl !== undefined}
      onPurchaseCompleted={(e) => onPurchaseCompleted?.(e.nativeEvent.result as PurchaseResult)}
      onPurchaseFailed={(e) => onPurchaseFailed?.(mapNativeError(e.nativeEvent.code, e.nativeEvent.message))}
      onCloseRequested={() => onClose?.()}
      onRestoreRequested={() => onRestore?.()}
      onUrlRequested={(e) => onUrl?.(e.nativeEvent.url)}
    />
  );
}
