// =============================================================
// Shared cross-module types
// =============================================================
//
// Small stuff that doesn't need its own module. Keep imports here
// minimal so circular deps stay at zero.

/**
 * Structural subset of the API logger. Anything we want the db
 * package to log through — e.g. the shadow-read helper — can
 * accept a `Logger` without pulling in pino or app-layer context.
 */
export interface Logger {
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  info?: (msg: string, extra?: Record<string, unknown>) => void;
  error?: (msg: string, extra?: Record<string, unknown>) => void;
}
