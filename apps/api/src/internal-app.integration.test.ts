// =============================================================
// internalApp — integration tests (Caddy on-demand-TLS ask endpoint)
// =============================================================
//
// Runs against the dev Postgres. Each test uses a unique RUN_ID-derived
// hostname so parallel runs and re-runs against the shared dev stack
// don't collide.

import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  customDomains,
  drizzle,
  funnels,
  getDb,
  projects,
} from "@rovenue/db";
import { internalApp } from "./internal-app";

const RUN_ID = Date.now();

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_iapp_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Internal App Test Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedFunnel(projectId: string, suffix = "") {
  const db = getDb();
  const id = `fnl_iapp_${RUN_ID}${suffix}`;
  await db.insert(funnels).values({
    id,
    projectId,
    slug: `funnel-iapp-${RUN_ID}${suffix}`,
    name: `Funnel ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedDomain(opts: {
  projectId: string;
  funnelId: string;
  hostname: string;
  verified: boolean;
}) {
  const row = await drizzle.customDomainRepo.insert(getDb(), {
    projectId: opts.projectId,
    funnelId: opts.funnelId,
    hostname: opts.hostname,
    verificationToken: "tok_" + Math.random().toString(36).slice(2),
  });
  if (opts.verified) {
    await getDb()
      .update(customDomains)
      .set({ verifiedAt: new Date() })
      .where(eq(customDomains.id, row.id));
  }
  return row;
}

const createdProjectIds: string[] = [];

afterAll(async () => {
  if (createdProjectIds.length > 0) {
    await getDb().delete(projects).where(inArray(projects.id, createdProjectIds));
  }
});

async function call(path: string) {
  return internalApp.request(`http://localhost${path}`);
}

describe("GET /internal/domains/check", () => {
  it("returns 200 for the canonical edge host", async () => {
    const res = await call("/internal/domains/check?domain=edge.rovenue.io");
    expect(res.status).toBe(200);
  });

  it("returns 200 for the bare canonical host", async () => {
    const res = await call("/internal/domains/check?domain=rovenue.io");
    expect(res.status).toBe(200);
  });

  it("returns 200 for a verified custom domain (regardless of cert_status)", async () => {
    const { id: projectId } = await seedProject("_a1");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_a1");
    const host = `ask-verified-${RUN_ID}.example.com`;
    await seedDomain({ projectId, funnelId, hostname: host, verified: true });

    const res = await call(`/internal/domains/check?domain=${host}`);
    expect(res.status).toBe(200);
  });

  it("returns 404 for an attached-but-unverified domain", async () => {
    const { id: projectId } = await seedProject("_a2");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_a2");
    const host = `ask-pending-${RUN_ID}.example.com`;
    await seedDomain({ projectId, funnelId, hostname: host, verified: false });

    const res = await call(`/internal/domains/check?domain=${host}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown hostname", async () => {
    const res = await call(`/internal/domains/check?domain=never-seen-${RUN_ID}.example.com`);
    expect(res.status).toBe(404);
  });

  it("lowercases the input — uppercase host with verified row passes", async () => {
    const { id: projectId } = await seedProject("_a3");
    createdProjectIds.push(projectId);
    const { id: funnelId } = await seedFunnel(projectId, "_a3");
    const host = `ask-mixedcase-${RUN_ID}.example.com`;
    await seedDomain({ projectId, funnelId, hostname: host, verified: true });

    const res = await call(`/internal/domains/check?domain=${host.toUpperCase()}`);
    expect(res.status).toBe(200);
  });

  it("returns 400 when domain query param is missing", async () => {
    const res = await call("/internal/domains/check");
    expect(res.status).toBe(400);
  });
});

describe("GET /internal/health", () => {
  it("returns 200", async () => {
    const res = await call("/internal/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
