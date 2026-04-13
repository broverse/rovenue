import type { ApiResponse, ErrorCode } from "@rovenue/shared";

export function ok<T>(data: T): ApiResponse<T> {
  return { data };
}

export function fail(code: ErrorCode, message: string): ApiResponse<never> {
  return { error: { code, message } };
}
