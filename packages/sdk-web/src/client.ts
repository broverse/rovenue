import type { Identity } from "./identity";

// =============================================================
// HTTP client
// =============================================================
//
// Every request goes to the BROWSER surface: `<apiUrl>/v1/web/<publicKey>`.
//
// The public key is in the path, not only in the Authorization header,
// because a CORS preflight carries no Authorization — the server has to know
// which project is asking at the moment it decides whether to allow the
// origin, and the URL is the only place a preflight can carry that.
//
// A consequence worth stating: if the key's origin list does not include the
// page's origin, requests fail with an opaque CORS error that never mentions
// Rovenue. That is a dashboard configuration step, and the error the browser
// shows cannot say so, which is why the docs lead with it.

/** Platform reported to the server. Persisted once, on subscriber create. */
const PLATFORM = "web";

export interface RovenueResponse<T> {
  data: T;
}

export interface RovenueErrorBody {
  error: { code: string; message: string };
}

export class RovenueApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RovenueApiError";
  }
}

export interface HttpClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, init?: { idempotencyKey?: string }): Promise<T>;
  /** Absolute base, e.g. `https://api.example/v1/web/pk_live_x`. */
  readonly baseUrl: string;
}

export interface CreateHttpClientOptions {
  apiUrl: string;
  publicKey: string;
  identity: Identity;
  fetchImpl?: typeof fetch;
}

export function createHttpClient(opts: CreateHttpClientOptions): HttpClient {
  const { apiUrl, publicKey, identity } = opts;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = `${apiUrl.replace(/\/+$/, "")}/v1/web/${publicKey}`;

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${publicKey}`,
      // ALWAYS the rovenueId. Never the app scope from identify() — that one
      // is client-local, and putting it here routes the request to an
      // orphaned subscriber.
      "x-rovenue-app-user-id": identity.rovenueId(),
      "x-rovenue-platform": PLATFORM,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async function unwrap<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let code = "HTTP_ERROR";
      let message = `Request failed with ${res.status}`;
      try {
        const body = (await res.json()) as RovenueErrorBody;
        if (body?.error) {
          code = body.error.code;
          message = body.error.message;
        }
      } catch {
        // A non-JSON error body (a proxy's HTML 502, say) must not mask the
        // status — the status is the useful part and it is already captured.
      }
      throw new RovenueApiError(res.status, code, message);
    }
    const body = (await res.json()) as RovenueResponse<T>;
    return body.data;
  }

  return {
    baseUrl,
    async get<T>(path: string): Promise<T> {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: headers(),
      });
      return unwrap<T>(res);
    },
    async post<T>(
      path: string,
      body: unknown,
      init?: { idempotencyKey?: string },
    ): Promise<T> {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: headers(
          init?.idempotencyKey
            ? { "Idempotency-Key": init.idempotencyKey }
            : undefined,
        ),
        body: JSON.stringify(body),
      });
      return unwrap<T>(res);
    },
  };
}
