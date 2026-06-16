import { startEventBridge } from "../core/eventBridge";
import { getNative } from "../core/native";
import { InvalidApiKeyError } from "../errors";
import { startSessionTracker } from "./sessionTracker";

export type RovenueConfig = {
  apiKey: string;
  /**
   * API host. Optional — defaults to the hosted endpoint
   * `https://api.rovenue.io`. Self-hosters pass their own origin
   * (e.g. `https://api.acme.com`). The Rust core enforces https://
   * (http:// is accepted only for localhost during local dev).
   */
  baseUrl?: string;
  debug?: boolean;
  /**
   * Optional override for the host app's user-facing version. When
   * omitted, the native modules auto-read the value:
   *   - iOS: `Bundle.main.infoDictionary["CFBundleShortVersionString"]`
   *   - Android: `packageManager.getPackageInfo(packageName, 0).versionName`
   * For Expo apps the auto-read value is baked from `app.json`'s
   * `expo.version` at prebuild time, so most callers should leave this
   * undefined.
   */
  appVersion?: string;
};

export function configure(opts: RovenueConfig): void {
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new InvalidApiKeyError("apiKey is blank");
  }
  if (opts.baseUrl !== undefined && !/^https?:\/\//.test(opts.baseUrl)) {
    throw new InvalidApiKeyError("baseUrl must start with http:// or https://");
  }
  const native = getNative();
  native.configure(
    opts.apiKey,
    opts.baseUrl,
    opts.debug ?? false,
    opts.appVersion,
  );
  startEventBridge();
  startSessionTracker();
}
