import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { ERROR_CODE, type ErrorCode } from "@rovenue/shared";
import { fail } from "../lib/response";
import { logger } from "../lib/logger";

const log = logger.child("error-handler");

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
    const code = mapHttpStatus(err.status);
    return c.json(fail(code, err.message), err.status);
  }

  if (err instanceof ZodError) {
    return c.json(fail(ERROR_CODE.VALIDATION_ERROR, err.message), 400);
  }

  log.error("unhandled error", {
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json(fail(ERROR_CODE.INTERNAL_ERROR, "Internal server error"), 500);
};
