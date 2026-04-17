import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger, type Logger as PinoLogger } from "@rovenue/shared";
import { env } from "./env";

// =============================================================
// Log levels (backwards-compat — many modules import these)
// =============================================================

export const LOG_LEVEL = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;
export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];

// =============================================================
// Request context via AsyncLocalStorage
//
// request-id middleware calls `requestContext.run(ctx, next)` so any
// logger call inside the request chain — including deeply nested
// services — automatically inherits the per-request fields.
// =============================================================

export interface RequestContextFields {
  requestId?: string;
  projectId?: string;
  subscriberId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContextFields>();

export function getRequestContext(): RequestContextFields | undefined {
  return requestContext.getStore();
}

export function mergeRequestContext(extra: RequestContextFields): void {
  const current = requestContext.getStore();
  if (!current) return;
  Object.assign(current, extra);
}

// =============================================================
// Pino instance
// =============================================================

function resolveLevel(): string {
  if (env.LOG_LEVEL) return env.LOG_LEVEL;
  if (env.NODE_ENV === "production") return "info";
  if (env.NODE_ENV === "test") return "silent";
  return "debug";
}

/**
 * Native Pino instance. Use this directly in new code to get the
 * Pino-native `logger.info({ fields }, "message")` call style with
 * full type hints from @types/pino.
 */
export const pinoLogger: PinoLogger = createLogger({
  service: "rovenue-api",
  environment: env.NODE_ENV,
  level: resolveLevel(),
  pretty: env.NODE_ENV === "development",
  mixin: () => (requestContext.getStore() ?? {}) as Record<string, unknown>,
});

// =============================================================
// Legacy wrapper — preserves the `log.info(message, fields)` API
// that all existing services already use. Internally delegates to
// Pino, so JSON output, scoped components, and ALS-injected request
// fields are all picked up automatically.
// =============================================================

export type LogFields = Readonly<Record<string, unknown>>;

export class Logger {
  constructor(private readonly pino: PinoLogger) {}

  /**
   * Create a scoped child logger. The `scope` string is recorded as
   * the `component` field on every child log line, matching Pino's
   * child-logger idiom.
   */
  child(scope: string): Logger {
    return new Logger(this.pino.child({ component: scope }));
  }

  debug(message: string, fields?: LogFields): void {
    this.pino.debug(fields ?? {}, message);
  }

  info(message: string, fields?: LogFields): void {
    this.pino.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.pino.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.pino.error(fields ?? {}, message);
  }
}

export const logger = new Logger(pinoLogger);
