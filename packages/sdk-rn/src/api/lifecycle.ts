import { stopEventBridge } from "../core/eventBridge";
import { getNative } from "../core/native";
import { stopSessionTracker } from "./sessionTracker";

/**
 * Tell the native SDK whether the host app is foregrounded, gating
 * background polling for entitlements/remote config and triggering an
 * immediate drain of the queued paywall-event queue on the foreground
 * transition. The bundled `sessionTracker` already calls this from
 * `AppState` changes, so most apps never need to call it directly.
 */
export function setForeground(foreground: boolean): void {
  getNative().setForeground(foreground);
}

/**
 * Tear down the SDK: stops the session tracker (recording a final
 * `close` event and flushing it) and the native-event bridge before
 * stopping the native module's own background polling. The native layer
 * already calls its own equivalent of this when `configure()` is invoked
 * a second time, so most apps never need to call it directly — reach for
 * it only when the host app is shutting the SDK down without immediately
 * reconfiguring.
 */
export function shutdown(): void {
  // Stop the session tracker first so the final 'close' + flush happen
  // before the native module is torn down.
  stopSessionTracker();
  stopEventBridge();
  getNative().shutdown();
}
