import { stopEventBridge } from "../core/eventBridge";
import { getNative } from "../core/native";
import { stopSessionTracker } from "./sessionTracker";

export function setForeground(foreground: boolean): void {
  getNative().setForeground(foreground);
}

export function shutdown(): void {
  // Stop the session tracker first so the final 'close' + flush happen
  // before the native module is torn down.
  stopSessionTracker();
  stopEventBridge();
  getNative().shutdown();
}
