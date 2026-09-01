// =============================================================
// Dashboard experiments — ELEMENT variant enforcement
//
// ELEMENT-type experiments patch one node's props per variant against a
// single shared "target paywall": every variant's `value` must be
// `{ paywallId, nodeId, props }` (packages/shared/src/experiments/types.ts
// `elementVariantValueSchema`), every variant of one experiment must name
// the SAME paywallId, `nodeId` must exist in that paywall's builder-config
// tree, and every key in `props` must be in
// `OVERRIDABLE_PROP_KEYS[node.type]`. Mirrors
// dashboard-experiments-paywall-variants.integration.test.ts (real
// Postgres, real Better Auth session).
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../src/lib/auth";
import { errorHandler } from "../src/middleware/error";
import { experimentsRoute } from "../src/routes/dashboard/experiments";

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/experiments", experimentsRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `expelement_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!expelement";
  const name = `Exp Element User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user?.id) throw new Error("signUp failed");

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const rawCookie = signIn.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(",").map((s) => s.trim().split(";")[0]).join("; ");
  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_expelem_${RUN_ID}${suffix}`;
  await db.insert(projects).values({ id, name: `Exp Element Project ${RUN_ID}${suffix}` });
  return { id };
}

async function seedMember({
  projectId,
  userId,
  role,
}: {
  projectId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "CUSTOMER_SUPPORT";
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({ projectId, userId, role });
}

async function seedOffering(projectId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.offerings)
    .values({ projectId, identifier: `offering_${RUN_ID}${suffix}`, packages: [] })
    .returning();
  return { id: row!.id };
}

const BUILDER_CONFIG = {
  formatVersion: 2 as const,
  defaultLocale: "en",
  localizations: { en: { title_key: "Go Pro" } },
  root: {
    type: "stack" as const,
    id: "root",
    axis: "v" as const,
    children: [{ type: "text" as const, id: "t1", key: "title_key" }],
  },
};

/** A paywall with a real builder-config tree — required for ELEMENT's
 *  nodeId/props checks to have something to validate against. */
async function seedPaywallWithBuilderConfig(projectId: string, offeringId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.paywalls)
    .values({
      projectId,
      identifier: `paywall_${RUN_ID}${suffix}`,
      name: `Paywall ${suffix}`,
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: { title: "x" } } },
      builderConfig: BUILDER_CONFIG,
    })
    .returning();
  return { id: row!.id };
}

async function seedAudience(projectId: string, suffix = "") {
  const db = getDb();
  const [row] = await db
    .insert(drizzle.schema.audiences)
    .values({ projectId, name: `Audience ${RUN_ID}${suffix}`, rules: {} })
    .returning();
  return { id: row!.id };
}

const seededProjectIds: string[] = [];
function trackProject(id: string) {
  seededProjectIds.push(id);
  return id;
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("POST /experiments — ELEMENT variant enforcement", () => {
  it("creates an ELEMENT experiment when every variant patches a real node with allowed props", async () => {
    const { userId, cookie } = await createUserAndSession("create-ok");
    const project = await seedProject("create-ok");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "create-ok");
    const paywall = await seedPaywallWithBuilderConfig(project.id, offering.id, "create-ok");
    const audience = await seedAudience(project.id, "create-ok");

    const app = buildApp();
    const res = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Element Experiment",
        type: "ELEMENT",
        audienceId: audience.id,
        variants: [
          {
            id: "control",
            name: "Control",
            value: { paywallId: paywall.id, nodeId: "t1", props: {} },
            weight: 0.5,
          },
          {
            id: "variant_a",
            name: "Variant A",
            value: { paywallId: paywall.id, nodeId: "t1", props: { color: { light: "#F00" } } },
            weight: 0.5,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("400s when an ELEMENT variant's value is missing paywallId/nodeId/props", async () => {
    const { userId, cookie } = await createUserAndSession("create-shape");
    const project = await seedProject("create-shape");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const audience = await seedAudience(project.id, "create-shape");

    const app = buildApp();
    const res = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Element Experiment Bad Shape",
        type: "ELEMENT",
        audienceId: audience.id,
        variants: [
          { id: "control", name: "Control", value: { ctaText: "Buy" }, weight: 0.5 },
          { id: "variant_a", name: "Variant A", value: { ctaText: "Go" }, weight: 0.5 },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/paywallId, nodeId, props/);
  });

  it("400s when ELEMENT variants disagree on paywallId", async () => {
    const { userId, cookie } = await createUserAndSession("create-mismatch");
    const project = await seedProject("create-mismatch");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "create-mismatch");
    const paywallA = await seedPaywallWithBuilderConfig(project.id, offering.id, "create-mismatch-a");
    const paywallB = await seedPaywallWithBuilderConfig(project.id, offering.id, "create-mismatch-b");
    const audience = await seedAudience(project.id, "create-mismatch");

    const app = buildApp();
    const res = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Element Experiment Mismatch",
        type: "ELEMENT",
        audienceId: audience.id,
        variants: [
          {
            id: "control",
            name: "Control",
            value: { paywallId: paywallA.id, nodeId: "t1", props: {} },
            weight: 0.5,
          },
          {
            id: "variant_a",
            name: "Variant A",
            value: { paywallId: paywallB.id, nodeId: "t1", props: {} },
            weight: 0.5,
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/same paywallId/);
  });

  it("400s when an ELEMENT variant names an unknown nodeId", async () => {
    const { userId, cookie } = await createUserAndSession("create-unknown-node");
    const project = await seedProject("create-unknown-node");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "create-unknown-node");
    const paywall = await seedPaywallWithBuilderConfig(project.id, offering.id, "create-unknown-node");
    const audience = await seedAudience(project.id, "create-unknown-node");

    const app = buildApp();
    const res = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Element Experiment Unknown Node",
        type: "ELEMENT",
        audienceId: audience.id,
        variants: [
          {
            id: "control",
            name: "Control",
            value: { paywallId: paywall.id, nodeId: "does-not-exist", props: {} },
            weight: 0.5,
          },
          {
            id: "variant_a",
            name: "Variant A",
            value: { paywallId: paywall.id, nodeId: "does-not-exist", props: { color: { light: "#F00" } } },
            weight: 0.5,
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Unknown nodeId/);
    expect(body.error.message).toMatch(/does-not-exist/);
  });

  it("400s when an ELEMENT variant's props include a key outside OVERRIDABLE_PROP_KEYS for that node type", async () => {
    const { userId, cookie } = await createUserAndSession("create-bad-prop");
    const project = await seedProject("create-bad-prop");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "create-bad-prop");
    const paywall = await seedPaywallWithBuilderConfig(project.id, offering.id, "create-bad-prop");
    const audience = await seedAudience(project.id, "create-bad-prop");

    const app = buildApp();
    // "t1" is a text node; OVERRIDABLE_PROP_KEYS.text is
    // ["key", "color", "align", "background", "cornerRadius"] — "axis" is
    // a structural field on stack nodes, never overridable on any node.
    const res = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Element Experiment Bad Prop",
        type: "ELEMENT",
        audienceId: audience.id,
        variants: [
          {
            id: "control",
            name: "Control",
            value: { paywallId: paywall.id, nodeId: "t1", props: {} },
            weight: 0.5,
          },
          {
            id: "variant_a",
            name: "Variant A",
            value: { paywallId: paywall.id, nodeId: "t1", props: { axis: "h" } },
            weight: 0.5,
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/not overridable/);
    expect(body.error.message).toMatch(/axis/);
  });
});

describe("PATCH /experiments/:id — DRAFT ELEMENT variant enforcement", () => {
  it("400s when PATCH swaps in a variant naming an unknown nodeId", async () => {
    const { userId, cookie } = await createUserAndSession("patch-unknown-node");
    const project = await seedProject("patch-unknown-node");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const offering = await seedOffering(project.id, "patch-unknown-node");
    const paywall = await seedPaywallWithBuilderConfig(project.id, offering.id, "patch-unknown-node");
    const audience = await seedAudience(project.id, "patch-unknown-node");

    const app = buildApp();
    const createRes = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        name: "Element Experiment Patch",
        type: "ELEMENT",
        audienceId: audience.id,
        variants: [
          {
            id: "control",
            name: "Control",
            value: { paywallId: paywall.id, nodeId: "t1", props: {} },
            weight: 0.5,
          },
          {
            id: "variant_a",
            name: "Variant A",
            value: { paywallId: paywall.id, nodeId: "t1", props: { color: { light: "#F00" } } },
            weight: 0.5,
          },
        ],
      }),
    });
    expect(createRes.status).toBe(200);
    const { data: createData } = (await createRes.json()) as { data: { experiment: { id: string } } };
    const experimentId = createData.experiment.id;

    const patchRes = await app.request(`/experiments/${experimentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        variants: [
          {
            id: "control",
            name: "Control",
            value: { paywallId: paywall.id, nodeId: "does-not-exist", props: {} },
            weight: 0.5,
          },
          {
            id: "variant_a",
            name: "Variant A",
            value: { paywallId: paywall.id, nodeId: "does-not-exist", props: {} },
            weight: 0.5,
          },
        ],
      }),
    });
    expect(patchRes.status).toBe(400);
  });
});
