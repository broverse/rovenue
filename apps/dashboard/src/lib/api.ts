import { hc, type InferRequestType, type InferResponseType } from "hono/client";
import type { AppType } from "@rovenue/api";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

// Hono RPC client. All paths + bodies + responses are inferred
// from the backend's chained `AppType` export at apps/api/src/app.ts.
//
//   const res = await rpc.dashboard.projects.$get();
//   const project = await unwrap(res);
//
// `credentials: "include"` is the dashboard default — Better Auth
// session cookies must round-trip on every call.
export const rpc = hc<AppType>(BASE_URL, {
  fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { credentials: "include", ...init })) as typeof fetch,
});

export type Rpc = typeof rpc;
export type { InferRequestType, InferResponseType };

// Unwrap the API's `{ data, error }` envelope. Hono RPC's
// `res.json()` returns the union of every status's response shape,
// so we narrow to `data` after checking `res.ok` and surface a
// typed `ApiError` for callers (matches the previous `api()` helper).
export async function unwrap<T>(res: Response): Promise<T> {
  const envelope = (await res.json().catch(() => null)) as
    | Envelope<T>
    | null;

  if (!res.ok) {
    const code = envelope?.error?.code ?? `HTTP_${res.status}`;
    const message = envelope?.error?.message ?? res.statusText;
    throw new ApiError(code, message, res.status);
  }

  if (!envelope || envelope.data === undefined) {
    throw new ApiError(
      "MALFORMED_RESPONSE",
      "Missing data envelope",
      res.status,
    );
  }

  return envelope.data;
}

// Back-compat shim for any caller still using the path-string
// `api()` helper. New code should prefer the typed `rpc` client.
export async function api<TResponse>(
  path: string,
  init?: RequestInit,
): Promise<TResponse> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: "include",
    ...init,
    headers,
  });

  return unwrap<TResponse>(res);
}
