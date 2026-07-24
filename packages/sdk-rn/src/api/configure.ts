import { startEventBridge } from "../core/eventBridge";
import { getNative } from "../core/native";
import { RovenueError } from "../errors";
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
  logLevel?: "off" | "error" | "warn" | "info" | "debug" | "trace";
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
  /**
   * Remote Config environment — selects which flag/experiment set the
   * backend serves: `"prod"` (default), `"staging"`, or `"development"`.
   * Sent as the `X-Rovenue-Env` header on the `/v1/config` request. Omit
   * to use production.
   */
  environment?: "prod" | "staging" | "development";
};

// The host app's version, as passed to `configure()`. Already in JS
// hands (it's forwarded to the native module below) but not otherwise
// retained JS-side; stashed here so the paywall render layer can read it
// for `visibility.minAppVersion`/`maxAppVersion` evaluation without a
// native round-trip. `undefined` until `configure()` runs, or when the
// caller omits it (native auto-reads its own value in that case, which
// this getter has no way to see).
let configuredAppVersion: string | undefined;

/** The `appVersion` most recently passed to `configure()`, if any. */
export function getConfiguredAppVersion(): string | undefined {
  return configuredAppVersion;
}

export function configure(opts: RovenueConfig): void {
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new RovenueError("InvalidApiKey", "apiKey is blank");
  }
  if (opts.baseUrl !== undefined && !/^https?:\/\//.test(opts.baseUrl)) {
    throw new RovenueError("InvalidApiKey", "baseUrl must start with http:// or https://");
  }
  configuredAppVersion = opts.appVersion;
  const native = getNative();
  native.configure(
    opts.apiKey,
    opts.baseUrl,
    opts.logLevel ?? "warn",
    opts.appVersion,
    opts.environment,
  );
  startEventBridge();
  startSessionTracker();
}
