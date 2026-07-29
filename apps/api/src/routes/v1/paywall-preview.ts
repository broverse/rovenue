import { Hono, type Context } from "hono";
import { drizzle } from "@rovenue/db";
import { ERROR_CODE } from "@rovenue/shared";
import { fail, ok } from "../../lib/response";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { hashToken } from "../../services/funnel/token";
import { hydrateDraftPaywall } from "../../lib/placement-resolution";

// =============================================================
// GET /v1/preview/paywalls/:token — P9 on-device preview (§6.17)
// =============================================================
//
// Public and UNAUTHENTICATED by design — mounted at ROOT in app.ts
// (`.route("/", paywallPreviewRoute)`, beside configStreamRoute) so it
// bypasses the /v1 apiKeyAuth envelope entirely. The token itself is
// the credential: it's minted by
// POST /dashboard/projects/:projectId/paywalls/:id/preview-sessions
// (see apps/api/src/routes/dashboard/paywalls.ts) and handed to a
// physical device out of band (QR code), which has no project API key
// to present.
//
// Serves `paywalls.builderConfig` (the DRAFT) via `hydrateDraftPaywall`
// — never the published snapshot `/v1/placements` serves. That's the
// one sanctioned exception to the draft/publish split; see the
// comment on `hydrateDraftPaywall` in placement-resolution.ts.
//
// SECURITY: missing, expired, revoked, and garbage tokens must be
// INDISTINGUISHABLE — always the same generic 404
// PREVIEW_SESSION_INVALID, so a scanning attacker can't use response
// shape/status as an oracle to enumerate live tokens. Every failure
// branch below funnels through `invalidToken()`.

// Headroom: the SDK polls this endpoint every 2s (30 req/min per device),
// so 120/min supports at most 4 devices sharing one preview token. A 5th
// device degrades gracefully rather than erroring — poll failures are
// swallowed client-side and the last-shown paywall just persists on screen.
export const PREVIEW_RATE_LIMIT_PER_MIN = 120;

const INVALID_TOKEN_MESSAGE = "Preview session not found or expired";

function invalidToken(c: Context) {
  return c.json(fail(ERROR_CODE.PREVIEW_SESSION_INVALID, INVALID_TOKEN_MESSAGE), 404);
}

export const paywallPreviewRoute = new Hono().get(
  "/v1/preview/paywalls/:token",
  endpointRateLimit({
    name: "paywall-preview",
    max: PREVIEW_RATE_LIMIT_PER_MIN,
    // `identify`'s `Context` type isn't narrowed to this route's params
    // (it's evaluated generically by the rate-limit middleware), so
    // `.param("token")` types as possibly-undefined here even though
    // the route pattern guarantees it's always present.
    identify: (c) => hashToken(c.req.param("token") ?? ""),
  }),
  async (c) => {
    const token = c.req.param("token");
    const tokenHash = hashToken(token);

    const session = await drizzle.previewSessionRepo.findActiveByHash(
      drizzle.db,
      tokenHash,
      new Date(),
    );
    if (!session) return invalidToken(c);

    // Defensive: the FK makes this practically unreachable (a paywall
    // can't be hard-deleted while a session references it), but a
    // dangling reference must fail exactly like every other invalid
    // case — never a different status/shape.
    const paywall = await drizzle.paywallRepo.findPaywallById(
      drizzle.db,
      session.projectId,
      session.paywallId,
    );
    if (!paywall) return invalidToken(c);

    // `updatedAt` doubles as the cache-busting revision: any edit to the
    // draft (including a re-save with no visible diff) bumps it, so a
    // client polling with If-None-Match always sees the latest draft
    // within one round trip of a save.
    const revision = paywall.updatedAt.toISOString();
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch === `"${revision}"`) {
      // BEFORE hydration — the whole point of the ETag short-circuit is
      // to skip the offering lookup + locale resolution hydrateDraftPaywall
      // does when the client already has the current draft.
      return c.body(null, 304);
    }

    const locale = c.req.query("locale") ?? null;
    const paywallWire = await hydrateDraftPaywall(session.projectId, paywall, locale);
    if (paywallWire === null) return invalidToken(c);

    c.header("ETag", `"${revision}"`);
    return c.json(ok({ ...paywallWire, revision }));
  },
);
