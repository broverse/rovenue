// =============================================================
// Public invitation routes integration tests
//
// Requires: real Postgres + real Better Auth sessions.
// No Redis / BullMQ dependency — token is minted directly and
// invitation is seeded via repo (bypassing the HTTP create path).
//
// Mirrors the inline-helper pattern from
// apps/api/src/routes/dashboard/invitations.integration.test.ts
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { generateInvitationToken } from "../../lib/invitation-token";
import { publicInvitationsRoute } from "./invitations";

const RUN_ID = Date.now();

function buildApp() {
  return new Hono().route("/invitations", publicInvitationsRoute);
}

async function createUserAndSession(suffix: string): Promise<{
  userId: string;
  cookie: string;
  email: string;
}> {
  const email = `pub_inv_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!pubinv";
  const name = `Pub Inv User ${suffix}`;

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
  const id = `prj_pubinv_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Pub Inv Project ${RUN_ID}${suffix}`,
  });
  return { id };
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
// 1. GET returns preview when pending
// =============================================================

describe("GET /invitations/:token", () => {
  it("1. Returns 200 with pending status when invitation is valid", async () => {
    const owner = await createUserAndSession("get_owner1");
    const project = await seedProject("_get1");
    trackProject(project.id);

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    await drizzle.invitationRepo.createInvitation(drizzle.db, {
      projectId: project.id,
      email: "invitee_get1@rovenue.test",
      role: "DEVELOPER",
      tokenHash: token.hash,
      invitedByUserId: owner.userId,
      expiresAt,
    });

    const app = buildApp();
    const res = await app.request(`/invitations/${token.plaintext}`, {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        projectName: string;
        email: string;
        status: string;
        role: string;
        expiresAt: string;
      };
    };
    expect(body.data.projectName).toBe(`Pub Inv Project ${RUN_ID}_get1`);
    expect(body.data.email).toBe("invitee_get1@rovenue.test");
    expect(body.data.status).toBe("pending");
    expect(body.data.role).toBe("DEVELOPER");
  });

  // =============================================================
  // 2. GET returns status='expired' for an expired invitation (not 404)
  // =============================================================

  it("2. Returns 200 with status=expired when invitation is expired", async () => {
    const owner = await createUserAndSession("get_owner2");
    const project = await seedProject("_get2");
    trackProject(project.id);

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() - 1000); // already expired
    await drizzle.invitationRepo.createInvitation(drizzle.db, {
      projectId: project.id,
      email: "invitee_get2@rovenue.test",
      role: "GROWTH",
      tokenHash: token.hash,
      invitedByUserId: owner.userId,
      expiresAt,
    });

    const app = buildApp();
    const res = await app.request(`/invitations/${token.plaintext}`, {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("expired");
  });
});

// =============================================================
// 3. POST accept requires auth
// =============================================================

describe("POST /invitations/:token/accept", () => {
  it("3. Returns 401 when no cookie is provided", async () => {
    const owner = await createUserAndSession("accept_owner3");
    const project = await seedProject("_accept3");
    trackProject(project.id);

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    await drizzle.invitationRepo.createInvitation(drizzle.db, {
      projectId: project.id,
      email: "invitee_accept3@rovenue.test",
      role: "DEVELOPER",
      tokenHash: token.hash,
      invitedByUserId: owner.userId,
      expiresAt,
    });

    const app = buildApp();
    const res = await app.request(
      `/invitations/${token.plaintext}/accept`,
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });

  // =============================================================
  // 4. POST accept: matching email creates membership + marks accepted
  //    Second POST → 409
  // =============================================================

  it("4. Matching email creates membership; re-accept returns 409", async () => {
    const owner = await createUserAndSession("accept_owner4");
    const invitee = await createUserAndSession("accept_invitee4");
    const project = await seedProject("_accept4");
    trackProject(project.id);

    // Owner must be a project member for audit to succeed
    await getDb().insert(drizzle.schema.projectMembers).values({
      projectId: project.id,
      userId: owner.userId,
      role: "OWNER",
    });

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    const invitation = await drizzle.invitationRepo.createInvitation(
      drizzle.db,
      {
        projectId: project.id,
        email: invitee.email,
        role: "DEVELOPER",
        tokenHash: token.hash,
        invitedByUserId: owner.userId,
        expiresAt,
      },
    );

    const app = buildApp();

    // First accept
    const res = await app.request(
      `/invitations/${token.plaintext}/accept`,
      {
        method: "POST",
        headers: { cookie: invitee.cookie },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { projectId: string; role: string };
    };
    expect(body.data.projectId).toBe(project.id);
    expect(body.data.role).toBe("DEVELOPER");

    // Confirm membership was created
    const membership = await drizzle.projectRepo.findMembership(
      drizzle.db,
      project.id,
      invitee.userId,
    );
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe("DEVELOPER");

    // Confirm invitation is marked accepted
    const inv = await drizzle.invitationRepo.findInvitationById(
      drizzle.db,
      invitation.id,
    );
    expect(inv?.acceptedAt).not.toBeNull();

    // Second accept → 409
    const res2 = await app.request(
      `/invitations/${token.plaintext}/accept`,
      {
        method: "POST",
        headers: { cookie: invitee.cookie },
      },
    );
    expect(res2.status).toBe(409);
  });

  // =============================================================
  // 5. POST accept: email mismatch → 403
  // =============================================================

  it("5. Email mismatch returns 403", async () => {
    const owner = await createUserAndSession("accept_owner5");
    const invitee = await createUserAndSession("accept_invitee5");
    const wrongUser = await createUserAndSession("accept_wrong5");
    const project = await seedProject("_accept5");
    trackProject(project.id);

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    await drizzle.invitationRepo.createInvitation(drizzle.db, {
      projectId: project.id,
      email: invitee.email,
      role: "DEVELOPER",
      tokenHash: token.hash,
      invitedByUserId: owner.userId,
      expiresAt,
    });

    const app = buildApp();
    const res = await app.request(
      `/invitations/${token.plaintext}/accept`,
      {
        method: "POST",
        headers: { cookie: wrongUser.cookie },
      },
    );
    expect(res.status).toBe(403);
  });
});
