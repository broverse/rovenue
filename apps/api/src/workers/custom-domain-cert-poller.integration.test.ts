// =============================================================
// runCustomDomainCertPollerSweep — integration tests
// =============================================================
//
// Exercises the sweep against the dev Postgres + Redis. Injects a
// fake cert probe so the test never opens a real TLS socket. The
// probe itself is unit-tested via the matchName / certCoversHostname
// helpers (small enough to test indirectly through the sweep).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  customDomains,
  drizzle,
  funnels,
  getDb,
  projects,
} from "@rovenue/db";
import { redis } from "../lib/redis";
import {
  runCustomDomainCertPollerSweep,
} from "./custom-domain-cert-poller";

const RUN_ID = Date.now();
const REDIS_PREFIX = "custom_domain:host:";

async function seedProject(suffix = "") {
  const id = `prj_cdcp_${RUN_ID}${suffix}`;
  await getDb().insert(projects).values({
    id,
    name: `Cert Poller Test Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedFunnel(projectId: string, suffix = "") {
  const id = `fnl_cdcp_${RUN_ID}${suffix}`;
  await getDb().insert(funnels).values({
    id,
    projectId,
    slug: `funnel-cdcp-${RUN_ID}${suffix}`,
    name: `Funnel ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedDomain(opts: {
  projectId: string;
  funnelId: string;
  hostname: string;
  verifiedAt: Date;
  certStatus?: "pending" | "issuing" | "issued" | "failed";
}) {
  const row = await drizzle.customDomainRepo.insert(getDb(), {
    projectId: opts.projectId,
    funnelId: opts.funnelId,
    hostname: opts.hostname,
    verificationToken: "tok_" + Math.random().toString(36).slice(2),
  });
  const patch: Record<string, unknown> = { verifiedAt: opts.verifiedAt };
  if (opts.certStatus) patch.certStatus = opts.certStatus;
  await getDb()
    .update(customDomains)
    .set(patch as never)
    .where(eq(customDomains.id, row.id));
  return drizzle.customDomainRepo.findById(getDb(), row.id);
}

const createdProjectIds: string[] = [];
const seededHostnames: string[] = [];

beforeAll(async () => {
  if (redis.status !== "ready" && redis.status !== "connecting") {
    await redis.connect();
  }
});

afterAll(async () => {
  if (createdProjectIds.length > 0) {
    await getDb().delete(projects).where(inArray(projects.id, createdProjectIds));
  }
  if (seededHostnames.length > 0) {
    await redis.del(...seededHostnames.map((h) => REDIS_PREFIX + h));
  }
  await redis.quit();
});

describe("runCustomDomainCertPollerSweep", () => {
  it("flips cert_status to issued when the probe says so", async () => {
    const { id: projectId } = await seedProject("_c1");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_c1");
    const host = `cert-issued-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    const row = await seedDomain({
      projectId,
      funnelId,
      hostname: host,
      verifiedAt: new Date(Date.now() - 60 * 1000), // 1 min ago
      certStatus: "pending",
    });

    // Pre-populate negative cache so we can confirm the sweep invalidates.
    await redis.set(REDIS_PREFIX + host, "∅", "EX", 60);

    await runCustomDomainCertPollerSweep(new Date(), async (h) => {
      expect(h).toBe(host);
      return { status: "issued", notAfter: new Date(Date.now() + 90 * 86400000) };
    });

    const after = await drizzle.customDomainRepo.findById(getDb(), row!.id);
    expect(after?.certStatus).toBe("issued");
    expect(after?.certIssuedAt).not.toBeNull();
    expect(after?.certFailureReason).toBeNull();
    // Resolver cache should be invalidated.
    expect(await redis.get(REDIS_PREFIX + host)).toBeNull();
  });

  it("records the failure reason when the probe says failed", async () => {
    const { id: projectId } = await seedProject("_c2");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_c2");
    const host = `cert-failed-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    const row = await seedDomain({
      projectId,
      funnelId,
      hostname: host,
      verifiedAt: new Date(Date.now() - 60 * 1000),
      certStatus: "pending",
    });

    await runCustomDomainCertPollerSweep(new Date(), async () => ({
      status: "failed",
      reason: "hostname_mismatch",
    }));

    const after = await drizzle.customDomainRepo.findById(getDb(), row!.id);
    expect(after?.certStatus).toBe("failed");
    expect(after?.certFailureReason).toBe("hostname_mismatch");
  });

  it("promotes pending → issuing on first 'issuing' probe", async () => {
    const { id: projectId } = await seedProject("_c3");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_c3");
    const host = `cert-issuing-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    const row = await seedDomain({
      projectId,
      funnelId,
      hostname: host,
      verifiedAt: new Date(Date.now() - 30 * 1000),
      certStatus: "pending",
    });

    await runCustomDomainCertPollerSweep(new Date(), async () => ({
      status: "issuing",
      reason: "self_signed_placeholder",
    }));

    const after = await drizzle.customDomainRepo.findById(getDb(), row!.id);
    expect(after?.certStatus).toBe("issuing");
  });

  it("times out rows still pending after the 30-min acquire window", async () => {
    const { id: projectId } = await seedProject("_c4");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_c4");
    const host = `cert-timeout-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    const row = await seedDomain({
      projectId,
      funnelId,
      hostname: host,
      verifiedAt: new Date(Date.now() - 31 * 60 * 1000), // 31 min ago
      certStatus: "issuing",
    });

    let probedThisHost = false;
    await runCustomDomainCertPollerSweep(new Date(), async (h) => {
      // The dev DB may carry stale rows from prior runs — scope the
      // assertion to OUR hostname so an unrelated probe doesn't flip
      // the flag.
      if (h === host) probedThisHost = true;
      return { status: "issuing", reason: "should-not-be-called" };
    });

    const after = await drizzle.customDomainRepo.findById(getDb(), row!.id);
    expect(after?.certStatus).toBe("failed");
    expect(after?.certFailureReason).toBe("acquire_window_expired");
    // Probe shouldn't fire for time-out rows — saves a TLS handshake.
    expect(probedThisHost).toBe(false);
  });

  it("ignores rows already in issued / failed state", async () => {
    const { id: projectId } = await seedProject("_c5");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_c5");
    const host = `cert-issued-skip-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    const row = await seedDomain({
      projectId,
      funnelId,
      hostname: host,
      verifiedAt: new Date(Date.now() - 5 * 60 * 1000),
      certStatus: "issued",
    });

    let probedThisHost = false;
    await runCustomDomainCertPollerSweep(new Date(), async (h) => {
      if (h === host) probedThisHost = true;
      return { status: "failed", reason: "noise" };
    });

    const after = await drizzle.customDomainRepo.findById(getDb(), row!.id);
    expect(after?.certStatus).toBe("issued"); // unchanged
    expect(probedThisHost).toBe(false);
  });
});
