import { env } from "./env";

export const LOG_LEVEL = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;
export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];

const LEVEL_ORDER: Record<LogLevel, number> = {
  [LOG_LEVEL.DEBUG]: 10,
  [LOG_LEVEL.INFO]: 20,
  [LOG_LEVEL.WARN]: 30,
  [LOG_LEVEL.ERROR]: 40,
};

export type LogFields = Readonly<Record<string, unknown>>;

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly minLevel: LogLevel,
  ) {}

  child(subScope: string, minLevel?: LogLevel): Logger {
    return new Logger(`${this.scope}:${subScope}`, minLevel ?? this.minLevel);
  }

  debug(message: string, fields?: LogFields): void {
    this.emit(LOG_LEVEL.DEBUG, message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.emit(LOG_LEVEL.INFO, message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit(LOG_LEVEL.WARN, message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.emit(LOG_LEVEL.ERROR, message, fields);
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const payload = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...(fields ?? {}),
    };

    const line = `${JSON.stringify(payload)}\n`;

    if (level === LOG_LEVEL.ERROR || level === LOG_LEVEL.WARN) {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }
}

const rootLevel: LogLevel =
  env.LOG_LEVEL ??
  (env.NODE_ENV === "production" ? LOG_LEVEL.INFO : LOG_LEVEL.DEBUG);

export const logger = new Logger("rovenue/api", rootLevel);
