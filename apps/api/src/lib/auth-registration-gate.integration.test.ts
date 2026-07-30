// =============================================================
// Registration gate — integration tests
//
// Exercises the databaseHooks.user.create.before hook wired in
// auth.ts. Uses real Postgres (localhost:5433 per docker-compose).
// Email/password signup is enabled outside production, so
// auth.api.signUpEmail exercises the hook directly.
//
// Harness mirrors members.integration.test.ts / projects.integration.test.ts:
//   - getDb() from @rovenue/db (pool already initialized via setup.ts)
//   - auth.api.signUpEmail via better-auth node client
//   - direct Drizzle inserts for seed data (drizzle.schema.*)
//   - beforeAll + afterEach truncation to guarantee a clean user table
//     between cases; afterAll removes the seed project row
//
// env mutation strategy:
//   env is a plain JS object (envSchema.parse returns an unfrozen object).
//   host-mode.ts reads env.HOST_MODE / env.ALLOW_REGISTRATION live on each
//   call to registrationOpen(), so per-case mutation + restore works without
//   vi.mock.
// =============================================================

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { eq } from "drizzle-orm";
import { auth } from "./auth";
import { env } from "./env";

// ----------------------------------------------------------------
// Stable IDs so cleanup is scoped and parallel runs don't collide
// ----------------------------------------------------------------

const RUN_ID = Date.now();
const SEED_PROJECT_ID = `prj_reggate_${RUN_ID}`;

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

async function signUp(email: string) {
  const password = "Test1234!reggate";
  const name = email.split("@")[0] ?? email;
  return auth.api.signUpEmail({ body: { email, password, name } });
}

async function seedProject() {
  await getDb()
    .insert(projects)
    .values({ id: SEED_PROJECT_ID, name: `Reg Gate Test Project ${RUN_ID}` })
    .onConflictDoNothing();
}

async function seedPendingInvitation(
  invitedEmail: string,
  founderUserId: string,
) {
  const tokenHash = `tok_rg_${RUN_ID}_${Math.random().toString(36).slice(2)}`;
  await drizzle.invitationRepo.createInvitation(getDb(), {
    projectId: SEED_PROJECT_ID,
    email: invitedEmail,
    role: "DEVELOPER",
    tokenHash,
    invitedByUserId: founderUserId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  });
}

// Wipe invitations for the seed project then all user rows.
// Better Auth cascades sessions/accounts via FK. The `user` table is
// shared across tests that run sequentially in this file only.
async function truncateForCase() {
  const db = getDb();
  // Remove invitations seeded by this test run first (FK: invitedByUserId → user.id).
  await db
    .delete(drizzle.schema.projectInvitations)
    .where(eq(drizzle.schema.projectInvitations.projectId, SEED_PROJECT_ID));
  // Delete all users — cascades to sessions, accounts, verifications.
  await db.execute(sql`DELETE FROM "user"`);
}

// ----------------------------------------------------------------
// Lifecycle
// ----------------------------------------------------------------

const origMode = env.HOST_MODE;
const origAllow = env.ALLOW_REGISTRATION;

beforeAll(async () => {
  // Ensure the seed project exists (FK anchor for invitations).
  await seedProject();
  // Start with a clean slate regardless of prior test runs.
  await truncateForCase();
});

afterAll(async () => {
  // Restore env.
  env.HOST_MODE = origMode;
  env.ALLOW_REGISTRATION = origAllow;
  // Remove the seed project row (invitations cascade-deleted by FK).
  await getDb().delete(projects).where(eq(projects.id, SEED_PROJECT_ID));
});

afterEach(async () => {
  // Restore env to the values active before this suite began.
  env.HOST_MODE = origMode;
  env.ALLOW_REGISTRATION = origAllow;
  // Clean up users + seeded invitations between cases.
  await truncateForCase();
});

// ----------------------------------------------------------------
// Tests — sequential (share the user table)
// ----------------------------------------------------------------

describe.sequential("registration gate (user.create hook)", () => {
  it("allows the first user even when registration is closed", async () => {
    env.HOST_MODE = "self";
    env.ALLOW_REGISTRATION = undefined;

    const result = await signUp("founder@example.com");
    expect(result?.user).toBeTruthy();

    const count = await drizzle.userRepo.countUsers(getDb());
    expect(count).toBe(1);
  });

  it("blocks a second uninvited user when closed", async () => {
    env.HOST_MODE = "self";
    env.ALLOW_REGISTRATION = undefined;

    // First user is always allowed.
    await signUp("founder@example.com");

    // Second uninvited user must be rejected.
    await expect(signUp("stranger@example.com")).rejects.toThrow(
      /registration_closed/,
    );
  });

  it("allows a second user when registration is open (cloud)", async () => {
    env.HOST_MODE = "cloud";
    env.ALLOW_REGISTRATION = undefined;

    await signUp("founder@example.com");
    const result = await signUp("second@example.com");
    expect(result?.user).toBeTruthy();
  });

  it("allows a second user when closed but a matching pending invite exists", async () => {
    env.HOST_MODE = "self";
    env.ALLOW_REGISTRATION = undefined;

    // Sign up the founder (first user — always allowed).
    const founderResult = await signUp("founder@example.com");
    const founderUserId = founderResult?.user?.id;
    if (!founderUserId) throw new Error("founder signup failed");

    // Seed a pending invitation for the second user.
    await seedPendingInvitation("invited@example.com", founderUserId);

    // Invited user must be allowed even though registration is closed.
    const result = await signUp("invited@example.com");
    expect(result?.user).toBeTruthy();
  });
});
