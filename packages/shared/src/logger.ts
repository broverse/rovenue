import { pino, type Logger as PinoLogger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
  /** Service identifier, e.g. "rovenue-api". Added to every log line. */
  service: string;
  /** Build/version tag if you have one. */
  version?: string;
  /** "development" | "production" | "test" — added as a base field. */
  environment?: string;
  /** Explicit pino level, otherwise caller's default. */
  level?: string;
  /** Enable pino-pretty transport for human-readable dev output. */
  pretty?: boolean;
  /**
   * Function merged into every log line. Used by apps to inject
   * AsyncLocalStorage-backed request context (requestId, projectId, …).
   */
  mixin?: () => Record<string, unknown>;
}

/**
 * Build a Pino logger with Rovenue's standard field layout. Apps extend
 * this with their own mixin function for request-scoped context.
 */
export function createLogger(opts: CreateLoggerOptions): PinoLogger {
  const options: LoggerOptions = {
    level: opts.level ?? "info",
    base: {
      service: opts.service,
      ...(opts.version ? { version: opts.version } : {}),
      ...(opts.environment ? { environment: opts.environment } : {}),
    },
    formatters: {
      // Emit `level: "info"` instead of pino's default numeric code.
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (opts.mixin) {
    options.mixin = opts.mixin;
  }

  if (opts.pretty) {
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    };
  }

  return pino(options);
}
