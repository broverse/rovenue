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

// The host app's version as `configure()` RESOLVED it — the caller's
// `appVersion` when given, otherwise the bundle/packageManager value the
// native module auto-read. Stashed here so the paywall render layer can
// evaluate `visibility.minAppVersion`/`maxAppVersion` without a native
// round-trip per node. `undefined` until `configure()` runs, and on a JS
// bundle running against a native binary predating `getAppVersion` (an
// RN dev can reload JS without rebuilding native) — version bounds then
// fail open, matching every other unknown in the visibility evaluator.
let configuredAppVersion: string | undefined;

/** The host app version `configure()` resolved, if any. */
export function getConfiguredAppVersion(): string | undefined {
  return configuredAppVersion;
}

/**
 * Initialize the SDK. Must be called before any other `Rovenue.*` call —
 * every other method assumes a configured native module and crashes
 * (`fatalError` on iOS, `IllegalStateException` on Android) otherwise.
 * Synchronous: also starts the native-event bridge that feeds the reactive
 * hooks/`addChangeListener`, and the foreground/background session
 * tracker (both are internally guarded to start at most once).
 *
 * Throws `RovenueError` (`kind: "InvalidApiKey"`) synchronously — before
 * any native call — when `apiKey` is blank or `baseUrl` doesn't start with
 * `http://`/`https://`.
 */
export function configure(opts: RovenueConfig): void {
  if (!opts.apiKey || opts.apiKey.trim() === "") {
    throw new RovenueError("InvalidApiKey", "apiKey is blank");
  }
  if (opts.baseUrl !== undefined && !/^https?:\/\//.test(opts.baseUrl)) {
    throw new RovenueError("InvalidApiKey", "baseUrl must start with http:// or https://");
  }
  const native = getNative();
  native.configure(
    opts.apiKey,
    opts.baseUrl,
    opts.logLevel ?? "warn",
    opts.appVersion,
    opts.environment,
  );
  // Read back rather than reusing `opts.appVersion`: most callers omit it
  // and let native auto-read, and this getter is what drives version-based
  // node visibility. Guarded for the stale-native-binary case above.
  configuredAppVersion =
    typeof native.getAppVersion === "function"
      ? (native.getAppVersion() ?? undefined)
      : opts.appVersion;
  startEventBridge();
  startSessionTracker();
}
