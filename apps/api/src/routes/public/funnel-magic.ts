// =============================================================
// Public magic-link resolver — /public/magic/:nonce
// =============================================================
//
// Counterpart to /v1/sdk/claim-via-email. The SES email contains
// a one-shot URL pointing here. We:
//
//   1. Read `funnel:magic:<nonce>` from Redis (15 min TTL).
//   2. DEL the key — single use; a click-once-share-link
//      retry never re-fires.
//   3. Look up the matching claim-token row to discover the
//      funnel's `deep_link_scheme`.
//   4. Serve an HTML page that immediately JS-redirects into the
//      app via `<scheme>://onboarding-complete?token=<plaintext>`
//      with a visible fallback link.
//
// We intentionally don't honour the magic link server-side
// (e.g. by returning JSON) — the device is the only place the
// SDK can pick the plaintext up and call /subscribers/claim-
// funnel-token.
// =============================================================

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "@rovenue/db";
import { redis } from "../../lib/redis";
import { hashToken } from "../../services/funnel/token";

interface FunnelDeepLinkSettings {
  deep_link_scheme?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const publicFunnelMagicRoute = new Hono().get("/:nonce", async (c) => {
  const nonce = c.req.param("nonce");
  if (!nonce || nonce.length < 16) {
    throw new HTTPException(400, { message: "Invalid magic link" });
  }

  const key = `funnel:magic:${nonce}`;
  const raw = await redis.get(key);
  if (!raw) {
    throw new HTTPException(410, { message: "Magic link expired" });
  }
  // One-shot: even if the user reloads the page, the deep link
  // payload below has already been pasted into the URL bar by
  // the JS redirect, so re-reading the nonce just to render the
  // fallback is unnecessary.
  await redis.del(key);

  let payload: { tokenPlaintext: string; installId: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HTTPException(500, { message: "Corrupt magic payload" });
  }
  const { tokenPlaintext } = payload;
  if (!tokenPlaintext) {
    throw new HTTPException(410, { message: "Magic link expired" });
  }

  // Resolve scheme via token → session → version.settings. If
  // anything is missing (rotated hash, deleted version) we fall
  // back to the global `rovenue://` scheme.
  let scheme = "rovenue";
  const tokenRow = await drizzle.funnelClaimTokenRepo.findByHash(
    drizzle.db,
    hashToken(tokenPlaintext),
  );
  if (tokenRow) {
    const session = await drizzle.funnelSessionRepo.findById(
      drizzle.db,
      tokenRow.sessionId,
    );
    if (session) {
      const version = await drizzle.funnelVersionRepo.findById(
        drizzle.db,
        session.funnelVersionId,
      );
      const settings = (version?.settingsJson ?? {}) as FunnelDeepLinkSettings;
      if (settings.deep_link_scheme) scheme = settings.deep_link_scheme;
    }
  }

  const deepLink = `${escapeHtml(scheme)}://onboarding-complete?token=${encodeURIComponent(
    tokenPlaintext,
  )}`;

  // Minimal HTML: meta-refresh + JS redirect + visible link
  // covers every mobile browser even if one of the redirect
  // mechanisms is blocked.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening Rovenue</title><meta http-equiv="refresh" content="0; url=${deepLink}"></head><body><p>Opening Rovenue…</p><p>If nothing happens, <a href="${deepLink}">tap here</a>.</p><script>window.location.replace(${JSON.stringify(deepLink)});</script></body></html>`;
  return c.html(html);
});
