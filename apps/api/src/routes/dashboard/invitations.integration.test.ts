// =============================================================
// Invitations route integration tests
//
// Requires: real Postgres + real Better Auth sessions + Redis.
// BullMQ jobs are enqueued to Redis but no worker runs here —
// emails are never sent. If Redis is unavailable the enqueue
// will fail and tests relying on POST create will error out.
//
// Mirrors the inline-helper pattern from members.integration.test.ts.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../middleware/error";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { invitationsRoute } from "./invitations";

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono().route(
    "/projects/:projectId/invitations",
    invitationsRoute,
  );
  app.onError(errorHandler);
  return app;
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string; email: string }> {
  const email = `inviteroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!inviteroute";
  const name = `Invite Route User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error(`no set-cookie for ${suffix}`);
  const cookie = cookieHeader.split(";")[0] ?? "";

  return { userId: signUp.user.id, cookie, email };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_inviteroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Invite Route Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedMember({
  projectId,
  userId,
  role,
}: {
  projectId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT";
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
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

// =============================================================
// 1. POST returns inviteUrl exactly once; GET omits it
// =============================================================

describe("POST /projects/:projectId/invitations", () => {
  it("1. POST returns 201 + inviteUrl; GET lists invitation without inviteUrl", async () => {
    const owner = await createUserAndSession("post_owner1");
    const project = await seedProject("_post1");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });

    const app = buildApp();

    // Create invitation
    const postRes = await app.request(
      `/projects/${project.id}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ email: "invitee_1@rovenue.test", role: "DEVELOPER" }),
      },
    );
    expect(postRes.status).toBe(201);
    const postBody = (await postRes.json()) as {
      data: { invitation: { id: string; status: string }; inviteUrl: string };
    };
    expect(postBody.data.inviteUrl).toMatch(/\/invitations\/rov_inv_/);
    expect(postBody.data.invitation.status).toBe("pending");

    // GET list — inviteUrl must NOT appear
    const getRes = await app.request(
      `/projects/${project.id}/invitations`,
      {
        method: "GET",
        headers: { cookie: owner.cookie },
      },
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: { invitations: Array<{ id: string; inviteUrl?: string }> };
    };
    expect(getBody.data.invitations).toHaveLength(1);
    expect(getBody.data.invitations[0]!.id).toBe(postBody.data.invitation.id);
    expect(getBody.data.invitations[0]!).not.toHaveProperty("inviteUrl");
  });

  // =============================================================
  // 2. POST blocks role = OWNER
  // =============================================================

  it("2. POST rejects role = OWNER (not in ASSIGNABLE_ROLES)", async () => {
    const owner = await createUserAndSession("post_owner2");
    const project = await seedProject("_post2");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ email: "invitee_2@rovenue.test", role: "OWNER" }),
      },
    );

    expect([400, 422]).toContain(res.status);
  });

  // =============================================================
  // 3. POST 409 when email is already a project member
  // =============================================================

  it("3. POST 409 when target email is already a project member", async () => {
    const owner = await createUserAndSession("post_owner3");
    const existingMember = await createUserAndSession("post_member3");
    const project = await seedProject("_post3");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });
    await seedMember({
      projectId: project.id,
      userId: existingMember.userId,
      role: "DEVELOPER",
    });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ email: existingMember.email, role: "DEVELOPER" }),
      },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toMatch(/ALREADY_MEMBER/);
  });

  // =============================================================
  // 4. POST replaces existing pending invite
  // =============================================================

  it("4. POST replaces existing pending invite; sets X-Rovenue-Refreshed header", async () => {
    const owner = await createUserAndSession("post_owner4");
    const project = await seedProject("_post4");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });

    const app = buildApp();

    // First invite
    const first = await app.request(
      `/projects/${project.id}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ email: "refreshee@rovenue.test", role: "DEVELOPER" }),
      },
    );
    expect(first.status).toBe(201);
    expect(first.headers.get("X-Rovenue-Refreshed")).toBeNull();

    // Second invite — same email, should refresh
    const second = await app.request(
      `/projects/${project.id}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ email: "refreshee@rovenue.test", role: "GROWTH" }),
      },
    );
    expect(second.status).toBe(201);
    expect(second.headers.get("X-Rovenue-Refreshed")).toBe("true");

    // Only one pending invite should appear in the list
    const getRes = await app.request(
      `/projects/${project.id}/invitations`,
      { method: "GET", headers: { cookie: owner.cookie } },
    );
    const getBody = (await getRes.json()) as {
      data: { invitations: Array<{ status: string; role: string }> };
    };
    const pending = getBody.data.invitations.filter((i) => i.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.role).toBe("GROWTH");
  });
});

// =============================================================
// 5. DELETE revokes the invitation
// =============================================================

describe("DELETE /projects/:projectId/invitations/:invitationId", () => {
  it("5. DELETE revokes invitation; subsequent GET shows status = revoked", async () => {
    const owner = await createUserAndSession("del_owner5");
    const project = await seedProject("_del5");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });

    const app = buildApp();

    // Create an invitation first
    const postRes = await app.request(
      `/projects/${project.id}/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ email: "torevoke@rovenue.test", role: "ADMIN" }),
      },
    );
    expect(postRes.status).toBe(201);
    const postBody = (await postRes.json()) as {
      data: { invitation: { id: string } };
    };
    const invitationId = postBody.data.invitation.id;

    // Delete it
    const delRes = await app.request(
      `/projects/${project.id}/invitations/${invitationId}`,
      { method: "DELETE", headers: { cookie: owner.cookie } },
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { data: { revoked: boolean } };
    expect(delBody.data.revoked).toBe(true);

    // GET list — status should be revoked
    const getRes = await app.request(
      `/projects/${project.id}/invitations`,
      { method: "GET", headers: { cookie: owner.cookie } },
    );
    const getBody = (await getRes.json()) as {
      data: { invitations: Array<{ id: string; status: string }> };
    };
    const found = getBody.data.invitations.find((i) => i.id === invitationId);
    expect(found?.status).toBe("revoked");
  });
});
