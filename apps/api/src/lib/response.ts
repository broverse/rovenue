import type { ApiResponse } from "@rovenue/shared";

export function ok<T>(data: T): ApiResponse<T> {
  return { data };
}

export function fail(code: string, message: string): ApiResponse<never> {
  return { error: { code, message } };
}
