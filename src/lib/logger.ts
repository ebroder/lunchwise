import * as Sentry from "@sentry/cloudflare";
import { env } from "./env.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields & { cause?: unknown }): void;
  with(context: Fields): Logger;
}

function getMinLevel(): number {
  const raw = env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVELS) return LEVELS[raw as LogLevel];
  return LEVELS.info;
}

function emit(level: LogLevel, msg: string, fields: Fields): void {
  const entry = { level, msg, ts: new Date().toISOString(), ...fields };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(context: Fields = {}): Logger {
  return {
    debug(msg, fields) {
      if (getMinLevel() <= LEVELS.debug) emit("debug", msg, { ...context, ...fields });
    },
    info(msg, fields) {
      if (getMinLevel() <= LEVELS.info) emit("info", msg, { ...context, ...fields });
    },
    warn(msg, fields) {
      if (getMinLevel() <= LEVELS.warn) emit("warn", msg, { ...context, ...fields });
    },
    error(msg, fields) {
      const { cause, ...rest } = { ...context, ...fields };
      if (getMinLevel() <= LEVELS.error) {
        emit("error", msg, rest);

        const err = cause instanceof Error ? cause : new Error(msg);
        Sentry.withScope((scope) => {
          scope.setExtras(rest);
          Sentry.captureException(err);
        });
      }
    },
    with(extra) {
      return createLogger({ ...context, ...extra });
    },
  };
}
