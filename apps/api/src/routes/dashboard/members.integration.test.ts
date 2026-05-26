// =============================================================
// Members route integration tests
//
// Real Postgres + real Better Auth sessions. Mirrors the inline-
// helper pattern from credits.integration.test.ts.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { membersRoute } from "./members";

const RUN_ID = Date.now();

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/members",
    membersRoute,
  );
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `membersroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!membersroute";
  const name = `Members Route User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error(`no set-cookie for ${suffix}`);
  const cookie = cookieHeader.split(";")[0] ?? "";

  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_membersroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Members Route Project ${RUN_ID}${suffix}`,
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
// PATCH /:userId — role update
// =============================================================

describe("PATCH /projects/:projectId/members/:userId", () => {
  it("1. ADMIN can patch another member's role (non-OWNER target)", async () => {
    const owner = await createUserAndSession("patch_owner");
    const admin = await createUserAndSession("patch_admin");
    const dev = await createUserAndSession("patch_dev");
    const project = await seedProject("_patch");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });
    await seedMember({ projectId: project.id, userId: admin.userId, role: "ADMIN" });
    await seedMember({ projectId: project.id, userId: dev.userId, role: "DEVELOPER" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/members/${dev.userId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin.cookie },
        body: JSON.stringify({ role: "GROWTH" }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { member: { role: string } } };
    expect(body.data.member.role).toBe("GROWTH");
  });

  it("2. PATCH cannot set role to OWNER", async () => {
    const owner = await createUserAndSession("patch_owner2");
    const admin = await createUserAndSession("patch_admin2");
    const dev = await createUserAndSession("patch_dev2");
    const project = await seedProject("_patch2");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });
    await seedMember({ projectId: project.id, userId: admin.userId, role: "ADMIN" });
    await seedMember({ projectId: project.id, userId: dev.userId, role: "DEVELOPER" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/members/${dev.userId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin.cookie },
        body: JSON.stringify({ role: "OWNER" }),
      },
    );

    expect(res.status).toBe(400);
  });

  it("3. Caller cannot change own role", async () => {
    const owner = await createUserAndSession("patch_selfowner");
    const admin = await createUserAndSession("patch_selfadmin");
    const project = await seedProject("_patchself");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });
    await seedMember({ projectId: project.id, userId: admin.userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/members/${admin.userId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin.cookie },
        body: JSON.stringify({ role: "DEVELOPER" }),
      },
    );

    expect(res.status).toBe(400);
  });
});

// =============================================================
// DELETE /:userId — remove member
// =============================================================

describe("DELETE /projects/:projectId/members/:userId", () => {
  it("4. DELETE cannot remove an OWNER", async () => {
    const owner = await createUserAndSession("del_owner");
    const admin = await createUserAndSession("del_admin");
    const project = await seedProject("_del");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });
    await seedMember({ projectId: project.id, userId: admin.userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/members/${owner.userId}`,
      {
        method: "DELETE",
        headers: { cookie: admin.cookie },
      },
    );

    expect(res.status).toBe(400);
  });
});

// =============================================================
// POST /transfer — ownership transfer
// =============================================================

describe("POST /projects/:projectId/members/transfer", () => {
  it("5. Target becomes OWNER, caller becomes ADMIN", async () => {
    const owner = await createUserAndSession("xfer_owner");
    const admin = await createUserAndSession("xfer_admin");
    const project = await seedProject("_xfer");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });
    await seedMember({ projectId: project.id, userId: admin.userId, role: "ADMIN" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/members/transfer`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ toUserId: admin.userId }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { transferred: boolean } };
    expect(body.data.transferred).toBe(true);

    // Verify roles swapped in DB
    const db = getDb();
    const newOwner = await drizzle.projectRepo.findMembership(
      db,
      project.id,
      admin.userId,
    );
    const demoted = await drizzle.projectRepo.findMembership(
      db,
      project.id,
      owner.userId,
    );
    expect(newOwner?.role).toBe("OWNER");
    expect(demoted?.role).toBe("ADMIN");
  });

  it("6. Cannot transfer to self", async () => {
    const owner = await createUserAndSession("xfer_self");
    const project = await seedProject("_xferself");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/members/transfer`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ toUserId: owner.userId }),
      },
    );

    expect(res.status).toBe(400);
  });

  it("7. Target must be a member", async () => {
    const owner = await createUserAndSession("xfer_nonmember");
    const stranger = await createUserAndSession("xfer_stranger");
    const project = await seedProject("_xfernonmember");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });
    // stranger is NOT seeded as a member

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/members/transfer`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ toUserId: stranger.userId }),
      },
    );

    expect(res.status).toBe(404);
  });
});
