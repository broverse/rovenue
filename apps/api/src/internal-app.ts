// =============================================================
// Internal-only HTTP surface
// =============================================================
//
// This Hono app is bound to a SEPARATE port from the public API and
// is never exposed in docker-compose `ports:`. Only Caddy (running
// on the same docker network) can reach it. Endpoints here are
// dangerous to expose externally because they would let an attacker
// enumerate which hostnames the platform serves.
//
// Caddy's on-demand-TLS feature calls `GET /internal/domains/check`
// before starting an ACME challenge — anything returning non-200
// means Caddy refuses to issue a cert, which protects us from
// Let's Encrypt rate-limit exhaustion via random-hostname spraying.
//
// Reference: https://caddyserver.com/docs/automatic-https#on-demand-tls

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { env } from "./lib/env";

export const internalApp = new Hono();

// ---------------------------------------------------------------
// GET /internal/domains/check?domain={hostname}
//
// Returns 200 iff:
//   - hostname is one of CANONICAL_HOSTS (the platform's own surface), OR
//   - hostname matches a custom_domains row that is VERIFIED.
//
// Note: we deliberately do NOT require cert_status='issued' here —
// the whole point of this endpoint is to gate Caddy's first cert
// issuance, which by definition happens while cert_status is still
// 'pending'. The serving-side resolver (host-resolver.ts) is the
// one that enforces cert_status='issued' before traffic flows.
// ---------------------------------------------------------------

internalApp.get("/internal/domains/check", async (c) => {
  const domain = c.req.query("domain")?.trim().toLowerCase() ?? "";
  if (!domain) return c.text("missing domain", 400);

  if (env.CANONICAL_HOSTS.includes(domain)) {
    return c.text("ok", 200);
  }

  const rows = await drizzle.db
    .select({ id: drizzle.customDomains.id })
    .from(drizzle.customDomains)
    .where(
      sql`${drizzle.customDomains.hostname} = ${domain} AND ${drizzle.customDomains.verifiedAt} IS NOT NULL`,
    )
    .limit(1);

  return rows.length > 0 ? c.text("ok", 200) : c.text("unknown", 404);
});

// Health probe so the docker healthcheck (and Caddy's tcp upstream
// check) have something cheap to hit.
internalApp.get("/internal/health", (c) => c.text("ok", 200));
