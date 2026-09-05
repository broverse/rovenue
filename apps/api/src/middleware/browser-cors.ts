import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { HEADER } from "@rovenue/shared";

// =============================================================
// Per-key CORS for the browser surface
// =============================================================
//
// A CORS preflight is an OPTIONS request that carries NO Authorization
// header, by definition. The server therefore cannot resolve the project
// from the Bearer key at the moment it must decide whether to allow the
// origin. That is the entire reason the public key sits in the URL
// (`/v1/web/:publicKey/...`): it is the only project reference a preflight
// can carry.
//
// MOUNT THIS ON THE PARAMETERISED PREFIX, never on `app.use("*")`. A route
// parameter is not available to app-level middleware — `c.req.param()` reads
// as undefined there, and every origin would be refused. Verified against
// the hono version vendored in this repo.
//
// What this does and does not buy: CORS is NOT an authorization boundary. A
// non-browser client ignores it entirely — `curl` with the public key is
// unaffected. What an origin restriction prevents is *another website's
// JavaScript* using this key inside a visitor's browser. Authorization rests
// on the unguessable rovenueId, the project scoping of the key, rate limits,
// and revocation.

/**
 * Resolves the browser origins a public key permits. Returns an empty list
 * for an unknown key, which refuses every origin — the same outcome as a key
 * that exists but has not been enabled for browser use.
 */
export type AllowedOriginLookup = (publicKey: string) => Promise<string[]>;

export const browserCors =
  (lookupAllowedOrigins: AllowedOriginLookup): MiddlewareHandler =>
  async (c, next) =>
    cors({
      origin: async (origin) => {
        const publicKey = c.req.param("publicKey");
        if (!publicKey) return null;
        const allowed = await lookupAllowedOrigins(publicKey);
        // Exact match: scheme, host and port. No wildcard support is
        // deliberate — a "https://*.example.com" entry would turn a
        // subdomain takeover into an API key.
        return allowed.includes(origin) ? origin : null;
      },
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "Idempotency-Key",
        HEADER.X_ROVENUE_APP_USER_ID,
        HEADER.X_ROVENUE_PLATFORM,
      ],
      exposeHeaders: [
        "X-Request-Id",
        HEADER.X_RATE_LIMIT_LIMIT,
        HEADER.X_RATE_LIMIT_REMAINING,
        "Retry-After",
      ],
      // Deliberate: the SDK sends a Bearer key and an app-user header, never
      // cookies. `credentials: true` alongside a reflected origin is the
      // combination that turns a CORS mistake into a session-riding one.
      credentials: false,
      maxAge: 86400,
    })(c, next);

/**
 * Asserts that the public key in the URL is the key the request authenticated
 * with.
 *
 * Without this the two are independent, and the origin restriction stops
 * meaning anything. A site whose own key allow-lists its origin can serve
 * JavaScript that calls `/v1/web/<its own key>/…` while sending
 * `Authorization: Bearer <another project's public key>`, scraped from that
 * project's page source. CORS passes, because it was checked against the key
 * in the path; the request is then authenticated, served and billed as the
 * other project — which is exactly the cross-site key use the allow-list
 * exists to prevent.
 *
 * Runs AFTER `apiKeyAuth`, which is what puts the authenticated key on the
 * context. A preflight never reaches here (hono's cors terminates it), so
 * this checks the request that actually carries data.
 */
export const requireMatchingPathKey: MiddlewareHandler = async (c, next) => {
  const pathKey = c.req.param("publicKey");
  const project = c.get("project");
  if (pathKey && project?.keyPublic && pathKey !== project.keyPublic) {
    throw new HTTPException(403, {
      message:
        "The API key in the URL is not the key this request authenticated " +
        "with. The browser surface requires both to be the same key.",
    });
  }
  await next();
};
