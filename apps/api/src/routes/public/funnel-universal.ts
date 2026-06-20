// =============================================================
// Universal link landing — /universal/funnels/open/:token
// =============================================================
//
// Single entrypoint shared between Android, iOS, and desktop:
//
//   - Android UA → redirect to Play Store with the install
//     referrer carrying the claim token, so the SDK can read it
//     on first launch via Google Play's INSTALL_REFERRER API.
//   - iOS UA → stash a `funnel_deferred_claims` fingerprint row
//     and redirect to the App Store. The SDK then calls
//     /sdk/claim-install with its own fingerprint to find the
//     matching deferred row.
//   - Anything else (desktop, bot) → render minimal HTML with
//     both store links so the user can pick.
//
// The :token plaintext lives in the URL by design — these links
// are issued one-per-session and rotated post-claim. We never
// log the plaintext server-side; only the hash hits the database.
// =============================================================

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "@rovenue/db";
import { hashToken } from "../../services/funnel/token";
import { buildInstallReferrer } from "../../services/funnel/install-referrer";
import { hashIp, normalizeFingerprint } from "../../services/funnel/fingerprint";

function detectPlatform(ua: string): "ios" | "android" | "other" {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface FunnelLandingSettings {
  play_store_url?: string;
  app_store_url?: string;
}

const DEFERRED_TTL_MS = 1 * 60 * 60 * 1000; // 1h window (was 24h) — IP-only match

export const publicFunnelUniversalRoute = new Hono().get(
  "/funnels/open/:token",
  async (c) => {
    const token = c.req.param("token");
    if (!token || token.length < 16) {
      throw new HTTPException(400, { message: "Invalid token" });
    }

    const tokenRow = await drizzle.funnelClaimTokenRepo.findByHash(
      drizzle.db,
      hashToken(token),
    );
    if (!tokenRow) {
      throw new HTTPException(404, { message: "Unknown token" });
    }
    if (tokenRow.expiresAt && tokenRow.expiresAt < new Date()) {
      throw new HTTPException(410, { message: "Token expired" });
    }

    const session = await drizzle.funnelSessionRepo.findById(
      drizzle.db,
      tokenRow.sessionId,
    );
    if (!session) {
      throw new HTTPException(404, { message: "Session missing" });
    }
    const version = await drizzle.funnelVersionRepo.findById(
      drizzle.db,
      session.funnelVersionId,
    );
    const settings = (version?.settingsJson ?? {}) as FunnelLandingSettings;

    const ua = c.req.header("user-agent") ?? "";
    const platform = detectPlatform(ua);

    if (platform === "android" && settings.play_store_url) {
      const referrer = buildInstallReferrer(token);
      const sep = settings.play_store_url.includes("?") ? "&" : "?";
      const url = `${settings.play_store_url}${sep}referrer=${referrer}`;
      return c.redirect(url, 302);
    }

    if (platform === "ios" && settings.app_store_url) {
      const ipHeader =
        c.req.header("x-forwarded-for") ??
        c.req.header("cf-connecting-ip") ??
        "";
      // server-side has neither screen size nor device timezone; the SDK
      // sends real values on /sdk/claim-install. The `0x0` (dims) and ``
      // (timezone) sentinels make fingerprintsMatch ignore those axes on
      // either side — otherwise a non-UTC device never matched.
      const fp = normalizeFingerprint({
        ip: ipHeader,
        userAgent: ua,
        locale: c.req.header("accept-language")?.split(",")[0] ?? "en",
        timezone: "",
        screenDims: "0x0",
      });
      await drizzle.funnelDeferredClaimRepo.insert(drizzle.db, {
        tokenId: tokenRow.id,
        platform: "ios",
        ipHash: fp.ipHash,
        userAgent: fp.userAgent,
        locale: fp.locale,
        timezone: fp.timezone,
        screenDims: fp.screenDims,
        deviceModel: fp.deviceModel,
        expiresAt: new Date(Date.now() + DEFERRED_TTL_MS),
      });
      return c.redirect(settings.app_store_url, 302);
    }

    // Fallback HTML with both store links so a desktop user can
    // hand the link off to their phone.
    const playLink = settings.play_store_url
      ? `<p><a href="${escapeHtml(settings.play_store_url)}">Get it on Google Play</a></p>`
      : "";
    const appLink = settings.app_store_url
      ? `<p><a href="${escapeHtml(settings.app_store_url)}">Download on the App Store</a></p>`
      : "";
    // Touch the ipHash to defuse unused-var lint if both links missing
    void hashIp;
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Rovenue</title></head><body><h1>Open Rovenue</h1>${appLink}${playLink}</body></html>`,
    );
  },
);
