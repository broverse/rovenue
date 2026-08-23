import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { ERROR_CODE, type ErrorCode } from "@rovenue/shared";
import { fail } from "../lib/response";
import { logger } from "../lib/logger";

const log = logger.child("error-handler");

// Services throw HTTPException without access to `c`, so a specific envelope
// code (e.g. PURCHASE_NOT_PAID) rides on the exception's `cause`. Only causes
// that name a known ERROR_CODE are honored — anything else (an Error object,
// an arbitrary string) falls back to the status→code mapping below.
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(ERROR_CODE),
);

function resolveErrorCode(err: HTTPException): ErrorCode {
  if (typeof err.cause === "string" && KNOWN_ERROR_CODES.has(err.cause)) {
    return err.cause as ErrorCode;
  }
  return mapHttpStatus(err.status);
}

function mapHttpStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ERROR_CODE.VALIDATION_ERROR;
    case 401:
      return ERROR_CODE.UNAUTHORIZED;
    case 403:
      return ERROR_CODE.FORBIDDEN;
    case 404:
      return ERROR_CODE.NOT_FOUND;
    case 429:
      return ERROR_CODE.RATE_LIMITED;
    case 501:
      return ERROR_CODE.NOT_IMPLEMENTED;
    default:
      return ERROR_CODE.HTTP_ERROR;
  }
}

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json(fail(resolveErrorCode(err), err.message), err.status);
  }

  if (err instanceof ZodError) {
    log.warn("validation error", {
      issues: err.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
    });
    return c.json(
      fail(ERROR_CODE.VALIDATION_ERROR, "Request validation failed"),
      400,
    );
  }

  log.error("unhandled error", {
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json(fail(ERROR_CODE.INTERNAL_ERROR, "Internal server error"), 500);
};
