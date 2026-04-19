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

  const envelope = (await res.json().catch(() => null)) as Envelope<TResponse> | null;

  if (!res.ok) {
    const code = envelope?.error?.code ?? `HTTP_${res.status}`;
    const message = envelope?.error?.message ?? res.statusText;
    throw new ApiError(code, message, res.status);
  }

  if (!envelope || envelope.data === undefined) {
    throw new ApiError("MALFORMED_RESPONSE", "Missing data envelope", res.status);
  }

  return envelope.data;
}
