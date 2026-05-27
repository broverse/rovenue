// =============================================================
// resolveHost / invalidateHost — integration tests
// =============================================================
//
// Runs against the dev Postgres (host:5433) + dev Redis (host:6380)
// configured in apps/api/tests/setup.ts. Each test uses a unique
// RUN_ID-derived hostname so parallel runs and re-runs against the
// shared dev stack don't collide.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  customDomains,
  drizzle,
  funnels,
  getDb,
  projects,
} from "@rovenue/db";
import { redis } from "../../lib/redis";
import {
  invalidateHost,
  resolveHost,
} from "./host-resolver";

const RUN_ID = Date.now();
const HOST_PREFIX = "tst-";
const REDIS_PREFIX = "custom_domain:host:";

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_hr_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Host Resolver Test Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedFunnel(projectId: string, status: "draft" | "published", suffix = "") {
  const db = getDb();
  const id = `fnl_hr_${RUN_ID}${suffix}`;
  await db.insert(funnels).values({
    id,
    projectId,
    slug: `funnel-hr-${RUN_ID}${suffix}`,
    name: `Funnel ${RUN_ID}${suffix}`,
    status,
  });
  return { id, slug: `funnel-hr-${RUN_ID}${suffix}` };
}

async function seedDomain({
  projectId,
  funnelId,
  hostname,
  verified,
  certIssued,
}: {
  projectId: string;
  funnelId: string;
  hostname: string;
  verified: boolean;
  certIssued: boolean;
}) {
  const row = await drizzle.customDomainRepo.insert(getDb(), {
    projectId,
    funnelId,
    hostname,
    verificationToken: "tok_" + Math.random().toString(36).slice(2),
  });
  const patch: Record<string, unknown> = {};
  if (verified) patch.verifiedAt = new Date();
  if (certIssued) {
    patch.certStatus = "issued";
    patch.certIssuedAt = new Date();
  }
  if (Object.keys(patch).length > 0) {
    await getDb()
      .update(customDomains)
      .set(patch as never)
      .where(eq(customDomains.id, row.id));
  }
  return drizzle.customDomainRepo.findById(getDb(), row.id);
}

const createdProjectIds: string[] = [];
const seededHostnames: string[] = [];

beforeAll(async () => {
  // lib/redis uses lazyConnect — first command would error with
  // "Stream isn't writeable and enableOfflineQueue options is false".
  // Force the connection up front so every test starts with a ready client.
  if (redis.status !== "ready" && redis.status !== "connecting") {
    await redis.connect();
  }
});

afterAll(async () => {
  // Clean up rows and any Redis keys we wrote.
  if (createdProjectIds.length > 0) {
    await getDb().delete(projects).where(inArray(projects.id, createdProjectIds));
  }
  if (seededHostnames.length > 0) {
    await redis.del(...seededHostnames.map((h) => REDIS_PREFIX + h));
  }
  await redis.quit();
});

describe("resolveHost", () => {
  it("returns null for a hostname with no row", async () => {
    const host = `${HOST_PREFIX}none-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    const result = await resolveHost(host);
    expect(result).toBeNull();
  });

  it("returns null for a pending (unverified) row", async () => {
    const { id: projectId } = await seedProject("_p1");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "published", "_p1");
    const host = `${HOST_PREFIX}pending-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    await seedDomain({ projectId, funnelId, hostname: host, verified: false, certIssued: false });

    expect(await resolveHost(host)).toBeNull();
  });

  it("returns null when verified but cert is still pending", async () => {
    const { id: projectId } = await seedProject("_p2");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "published", "_p2");
    const host = `${HOST_PREFIX}verified-no-cert-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    await seedDomain({ projectId, funnelId, hostname: host, verified: true, certIssued: false });

    expect(await resolveHost(host)).toBeNull();
  });

  it("resolves when row is verified AND cert is issued AND funnel is published", async () => {
    const { id: projectId } = await seedProject("_p3");
    createdProjectIds.push(projectId);
    const { id: funnelId, slug } = await seedFunnel(projectId, "published", "_p3");
    const host = `${HOST_PREFIX}ready-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    await seedDomain({ projectId, funnelId, hostname: host, verified: true, certIssued: true });

    const result = await resolveHost(host);
    expect(result).toEqual({ funnelId, slug });
  });

  it("returns null when row is ready but funnel is still draft", async () => {
    const { id: projectId } = await seedProject("_p4");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "draft", "_p4");
    const host = `${HOST_PREFIX}draft-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    await seedDomain({ projectId, funnelId, hostname: host, verified: true, certIssued: true });

    expect(await resolveHost(host)).toBeNull();
  });

  it("strips :port and lowercases the Host header", async () => {
    const { id: projectId } = await seedProject("_p5");
    createdProjectIds.push(projectId);
    const { id: funnelId, slug } = await seedFunnel(projectId, "published", "_p5");
    const host = `${HOST_PREFIX}port-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    await seedDomain({ projectId, funnelId, hostname: host, verified: true, certIssued: true });

    // Caller passes mixed-case + a port — resolver normalises both.
    const result = await resolveHost(`${host.toUpperCase()}:8443`);
    expect(result).toEqual({ funnelId, slug });
  });

  it("caches a positive result — second call hits Redis without re-reading Postgres", async () => {
    const { id: projectId } = await seedProject("_p6");
    createdProjectIds.push(projectId);
    const { id: funnelId, slug } = await seedFunnel(projectId, "published", "_p6");
    const host = `${HOST_PREFIX}cache-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    await seedDomain({ projectId, funnelId, hostname: host, verified: true, certIssued: true });

    expect(await resolveHost(host)).toEqual({ funnelId, slug });

    // Mutate Postgres out-of-band; if the resolver re-reads it should
    // return null, but the cache should still return the stale positive.
    await getDb()
      .update(customDomains)
      .set({ verifiedAt: null })
      .where(eq(customDomains.hostname, host));

    expect(await resolveHost(host)).toEqual({ funnelId, slug });

    // After explicit invalidation the re-read sees the new state.
    await invalidateHost(host);
    expect(await resolveHost(host)).toBeNull();
  });

  it("caches negative results too — second miss skips Postgres", async () => {
    const host = `${HOST_PREFIX}negative-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    // No seed at all.
    expect(await resolveHost(host)).toBeNull();
    const cached = await redis.get(REDIS_PREFIX + host);
    expect(cached).toBe("∅");
  });
});

describe("invalidateHost", () => {
  it("removes the cached entry", async () => {
    const { id: projectId } = await seedProject("_i1");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "published", "_i1");
    const host = `${HOST_PREFIX}invalidate-${RUN_ID}.example.com`;
    seededHostnames.push(host);
    await seedDomain({ projectId, funnelId, hostname: host, verified: true, certIssued: true });

    await resolveHost(host); // populate the cache
    expect(await redis.get(REDIS_PREFIX + host)).not.toBeNull();

    await invalidateHost(host);
    expect(await redis.get(REDIS_PREFIX + host)).toBeNull();
  });
});
