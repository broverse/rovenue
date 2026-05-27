import { stopEventBridge } from "../core/eventBridge";
import { getNative } from "../core/native";

export function setForeground(foreground: boolean): void {
  getNative().setForeground(foreground);
}

export function shutdown(): void {
  stopEventBridge();
  getNative().shutdown();
}
