// =============================================================
// Runtime configuration
// =============================================================
//
// The ONE module allowed to read `import.meta.env.VITE_*`, enforced by an
// eslint rule in eslint.config.mjs.
//
// Vite inlines `import.meta.env.VITE_*` at BUILD time, so a published
// dashboard image would carry whatever the release build was given —
// http://localhost:3000 — and no operator could change it. The container
// therefore serves /config.js, which assigns window.__ROVENUE_CONFIG__
// before the bundle loads (deploy/caddy/Caddyfile.dashboard).
//
// Runtime wins over build time: in a published image the build-time value
// is only ever the development default. `import.meta.env` remains the
// `pnpm dev` path, where Vite serves the empty public/config.js.

export const DEFAULT_API_BASE_URL = "http://localhost:3000";

/** Shape assigned by /config.js. Keys mirror deploy/caddy/Caddyfile.dashboard. */
export interface RuntimeConfig {
  apiUrl?: string;
  hostMode?: string;
  allowRegistration?: string;
  dashboardHost?: string;
}

/** The build-time values Vite inlines. */
export interface BuildEnv {
  VITE_API_URL?: string;
  VITE_HOST_MODE?: string;
  VITE_ALLOW_REGISTRATION?: string;
  VITE_DASHBOARD_HOST?: string;
}

export interface ResolvedConfig {
  apiUrl: string;
  hostMode?: string;
  allowRegistration?: string;
  dashboardHost?: string;
}

declare global {
  interface Window {
    __ROVENUE_CONFIG__?: RuntimeConfig;
  }
}

/** Caddy emits `{$VAR:}` for unset variables, which arrives as "". */
function firstSet(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** Pure — tests drive it without stubbing globals or import.meta.env. */
export function resolveRuntimeConfig(
  runtime: RuntimeConfig | undefined,
  build: BuildEnv,
): ResolvedConfig {
  return {
    apiUrl: firstSet(runtime?.apiUrl, build.VITE_API_URL) ?? DEFAULT_API_BASE_URL,
    hostMode: firstSet(runtime?.hostMode, build.VITE_HOST_MODE),
    allowRegistration: firstSet(runtime?.allowRegistration, build.VITE_ALLOW_REGISTRATION),
    dashboardHost: firstSet(runtime?.dashboardHost, build.VITE_DASHBOARD_HOST),
  };
}

const resolved = resolveRuntimeConfig(
  typeof window === "undefined" ? undefined : window.__ROVENUE_CONFIG__,
  {
    VITE_API_URL: import.meta.env.VITE_API_URL as string | undefined,
    VITE_HOST_MODE: import.meta.env.VITE_HOST_MODE as string | undefined,
    VITE_ALLOW_REGISTRATION: import.meta.env.VITE_ALLOW_REGISTRATION as string | undefined,
    VITE_DASHBOARD_HOST: import.meta.env.VITE_DASHBOARD_HOST as string | undefined,
  },
);

export function apiBaseUrl(): string {
  return resolved.apiUrl;
}

export function hostModeValue(): string | undefined {
  return resolved.hostMode;
}

export function allowRegistrationValue(): string | undefined {
  return resolved.allowRegistration;
}

export function dashboardHostValue(): string | undefined {
  return resolved.dashboardHost;
}
