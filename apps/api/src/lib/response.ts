import type { ErrorCode } from "@rovenue/shared";

// `ok`/`fail` are typed to their own narrow shape (`{ data: T }` /
// `{ error: {...} }`), NOT the wider `ApiResponse<T>` union. Both branches
// of that union are valid `ApiResponse<T>`, but a two-branch object union
// with disjoint keys has `keyof` = never — every route that returned
// `ApiResponse<T>` from `c.json(ok(...))` was silently erasing its response
// shape for `hc<AppType>()` consumers (dashboard/SDK RPC clients), because
// `InferResponseType` on that route collapsed to the union with no usable
// keys. Narrowing here lets each route's actual response (success XOR
// error, never both) type-check as what it really returns.
export function ok<T>(data: T): { data: T } {
  return { data };
}

export function fail(
  code: ErrorCode,
  message: string,
): { error: { code: ErrorCode; message: string } } {
  return { error: { code, message } };
}
