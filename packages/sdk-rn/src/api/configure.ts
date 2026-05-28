import { startEventBridge } from "../core/eventBridge";
import { getNative } from "../core/native";
import { InvalidApiKeyError } from "../errors";
import { startSessionTracker } from "./sessionTracker";

export type RovenueConfig = {
  apiKey: string;
  baseUrl: string;
  debug?: boolean;
};

export function configure(opts: RovenueConfig): void {
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new InvalidApiKeyError("apiKey is blank");
  }
  if (!/^https?:\/\//.test(opts.baseUrl)) {
    throw new InvalidApiKeyError("baseUrl must start with http:// or https://");
  }
  const native = getNative();
  native.configure(opts.apiKey, opts.baseUrl, opts.debug ?? false);
  startEventBridge();
  startSessionTracker();
}
