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
  post<T>(
    path: string,
    body: unknown,
    init?: { idempotencyKey?: string; keepalive?: boolean },
  ): Promise<T>;
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
      // BOTH headers, as the Rust core sends. /v1/placements, /v1/config and
      // /v1/experiments read the subscriber from `x-rovenue-user-id`, not
      // from the app-user one. Sending only the latter left every web request
      // anonymous: audience-targeted placement rows could never match (only
      // an `audienceId: null` row can with no attributes), and a null
      // subscriber forces the project holdout to 0 — so web traffic was
      // silently excluded from the holdout and polluted the baseline.
      "x-rovenue-user-id": identity.rovenueId(),
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
    // /v1/events answers `202` with NO body, and several endpoints answer
    // 204. Calling res.json() on those throws a SyntaxError, which the event
    // queue would read as "not acknowledged" — replaying an event the server
    // had already ingested, on every flush and every page load, forever.
    if (res.status === 204 || res.status === 202) return undefined as T;
    const text = await res.text();
    if (text === "") return undefined as T;
    const body = JSON.parse(text) as RovenueResponse<T>;
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
      init?: { idempotencyKey?: string; keepalive?: boolean },
    ): Promise<T> {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: headers(
          init?.idempotencyKey
            ? { "Idempotency-Key": init.idempotencyKey }
            : undefined,
        ),
        body: JSON.stringify(body),
        // Survives the page being unloaded, which is the whole reason the
        // event queue can flush on pagehide at all. sendBeacon cannot be
        // used here: it sets no headers, and this API authenticates from
        // Authorization.
        ...(init?.keepalive ? { keepalive: true } : {}),
      });
      return unwrap<T>(res);
    },
  };
}
