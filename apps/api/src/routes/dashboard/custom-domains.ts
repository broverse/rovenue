import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";
import {
  CANONICAL_EDGE_HOST,
  checkHostname,
  verifyCustomDomain,
} from "../../services/custom-domains/verify";
import { invalidateHost } from "../../services/custom-domains/host-resolver";

// =============================================================
// Dashboard: Custom Domains
// =============================================================
//
// Attach an arbitrary hostname to a single funnel. Mutations are
// DEVELOPER-gated; reads use baseline project membership. Hostnames
// are global (unique across all projects) because DNS doesn't honour
// our project boundaries — a collision is therefore surfaced as 409.
//
// Lifecycle:
//   POST   /                 → row in `pending` state with a TXT token
//   POST   /:id/verify       → synchronous CNAME + TXT check; flips verifiedAt
//   DELETE /:id              → revoke; cache invalidation happens here (TODO step 5)
//
// The verify endpoint short-circuits on hostname-shape / reserved-list
// rejection at create-time so we never persist a row that the verifier
// will refuse anyway.

const attachBodySchema = z.object({
  funnelId: z.string().min(1),
  hostname: z.string().min(3).max(253),
});

function freshToken(): string {
  return randomBytes(32).toString("hex");
}

function serialize(row: NonNullable<Awaited<ReturnType<typeof drizzle.customDomainRepo.findById>>>) {
  return {
    id: row.id,
    projectId: row.projectId,
    funnelId: row.funnelId,
    hostname: row.hostname,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    verificationFailureReason: row.verificationFailureReason,
    certStatus: row.certStatus,
    certIssuedAt: row.certIssuedAt,
    certFailureReason: row.certFailureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // The values the dashboard needs to surface to the operator so they
    // can configure DNS. Re-emitted on every read so the UI never has to
    // re-fetch a per-row "DNS instructions" endpoint.
    verification: {
      cname: { name: row.hostname, value: CANONICAL_EDGE_HOST },
      txt: { name: `_rovenue.${row.hostname}`, value: `rv-verify=${row.verificationToken}` },
    },
  };
}

export const customDomainsRoute = new Hono()
  .use("*", requireDashboardAuth)

  // ----- GET /dashboard/projects/:projectId/custom-domains -----
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const rows = await drizzle.customDomainRepo.listByProject(drizzle.db, projectId);
    return c.json(ok({ domains: rows.map(serialize) }));
  })

  // ----- POST /dashboard/projects/:projectId/custom-domains -----
  .post("/", zValidator("json", attachBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const body = c.req.valid("json");
    const hostname = body.hostname.trim().toLowerCase();

    const shape = checkHostname(hostname);
    if (!shape.ok) {
      throw new HTTPException(400, { message: shape.reason });
    }

    // Confirm the funnel belongs to this project before claiming a hostname
    // on its behalf — and that no row already exists for it (one funnel ↔
    // one custom domain enforced at the DB layer too via the unique index).
    const funnel = await drizzle.funnelRepo.findById(drizzle.db, body.funnelId);
    if (!funnel || funnel.projectId !== projectId) {
      throw new HTTPException(404, { message: "Funnel not found" });
    }
    const existingForFunnel = await drizzle.customDomainRepo.findByFunnel(drizzle.db, body.funnelId);
    if (existingForFunnel) {
      throw new HTTPException(409, { message: "funnel_already_has_domain" });
    }

    // Global hostname uniqueness — pre-check for a friendly error before
    // the DB throws unique_violation. Race-safe via the catch below.
    const existingForHost = await drizzle.customDomainRepo.findByHostname(drizzle.db, hostname);
    if (existingForHost) {
      throw new HTTPException(409, { message: "hostname_taken" });
    }

    try {
      const created = await drizzle.db.transaction(async (tx) => {
        const row = await drizzle.customDomainRepo.insert(tx, {
          projectId,
          funnelId: body.funnelId,
          hostname,
          verificationToken: freshToken(),
          createdBy: user.id,
        });
        await audit(
          {
            projectId,
            userId: user.id,
            action: "custom_domain.created",
            resource: "custom_domain",
            resourceId: row.id,
            after: { hostname: row.hostname, funnelId: row.funnelId },
            ...extractRequestContext(c),
          },
          tx,
        );
        return row;
      });
      return c.json(ok(serialize(created)), 201);
    } catch (err) {
      // Catch the unique_violation that beats us to the punch under
      // concurrent claims — Postgres SQLSTATE 23505.
      if ((err as { code?: string })?.code === "23505") {
        throw new HTTPException(409, { message: "hostname_taken" });
      }
      throw err;
    }
  })

  // ----- POST /dashboard/projects/:projectId/custom-domains/:id/verify -----
  .post("/:id/verify", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) throw new HTTPException(400, { message: "Missing id" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const row = await drizzle.customDomainRepo.findById(drizzle.db, id);
    if (!row || row.projectId !== projectId) {
      throw new HTTPException(404, { message: "Custom domain not found" });
    }

    const result = await verifyCustomDomain(row.hostname, row.verificationToken);
    const now = new Date();

    const updated = await drizzle.db.transaction(async (tx) => {
      const next = await drizzle.customDomainRepo.updateById(tx, id, result.ok
        ? {
            verifiedAt: now,
            lastCheckedAt: now,
            verificationFailureReason: null,
            // Until Caddy issues, leave cert_status at its current value
            // ('pending' on first verify). The cert-status poller flips it.
          }
        : {
            lastCheckedAt: now,
            verificationFailureReason: result.reason,
          });
      if (!next) throw new HTTPException(404, { message: "Custom domain not found" });
      await audit(
        {
          projectId,
          userId: user.id,
          action: result.ok ? "custom_domain.verified" : "custom_domain.verify_failed",
          resource: "custom_domain",
          resourceId: id,
          after: result.ok
            ? { hostname: next.hostname }
            : { hostname: next.hostname, reason: result.reason },
          ...extractRequestContext(c),
        },
        tx,
      );
      return next;
    });

    // Bust the resolver cache so the next request sees the new
    // verification state (a negative entry from before the verify
    // landed would otherwise live for up to 60 s).
    await invalidateHost(updated.hostname);

    return c.json(ok({ ...serialize(updated), result }));
  })

  // ----- DELETE /dashboard/projects/:projectId/custom-domains/:id -----
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) throw new HTTPException(400, { message: "Missing id" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const row = await drizzle.customDomainRepo.findById(drizzle.db, id);
    // Cross-project access returns 404 (not 403) — never leak existence.
    if (!row || row.projectId !== projectId) {
      throw new HTTPException(404, { message: "Custom domain not found" });
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.customDomainRepo.deleteById(tx, id);
      await audit(
        {
          projectId,
          userId: user.id,
          action: "custom_domain.deleted",
          resource: "custom_domain",
          resourceId: id,
          before: { hostname: row.hostname, funnelId: row.funnelId },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    await invalidateHost(row.hostname);
    return c.json(ok({ deleted: true }));
  });
