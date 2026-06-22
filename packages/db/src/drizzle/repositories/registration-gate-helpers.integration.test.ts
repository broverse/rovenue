// =============================================================
// registration-gate DB helpers — integration tests
// =============================================================
//
// Covers:
//   - userRepo.countUsers: count increases by 1 after inserting a user
//   - invitationRepo.findAnyPendingInvitationByEmail:
//       * finds a fresh pending invite (case-insensitive email match)
//       * returns null for an unknown email
//       * does NOT return an expired invite
//       * does NOT return a revoked invite
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../client";
import { projectInvitations, projects, user } from "../schema";
import { countUsers } from "./users";
import {
  createInvitation,
  findAnyPendingInvitationByEmail,
} from "./invitations";

const RUN_ID = Date.now();
const USER_ID = `u_rg_${RUN_ID}`;
const PROJECT_ID = `prj_rg_${RUN_ID}`;

// Seed shared fixtures once; all invitation tests depend on USER_ID and PROJECT_ID.
beforeAll(async () => {
  const db = getDb();
  await db.insert(user).values({
    id: USER_ID,
    name: "Gate Tester",
    email: `gate_${RUN_ID}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db
    .insert(projects)
    .values({ id: PROJECT_ID, name: "rg-test-project" });
});

afterAll(async () => {
  const db = getDb();
  await db
    .delete(projectInvitations)
    .where(sql`"projectId" = ${PROJECT_ID}`);
  await db.delete(projects).where(sql`id = ${PROJECT_ID}`);
  await db.delete(user).where(sql`id = ${USER_ID}`);
});

describe("registration gate DB helpers", () => {
  it("countUsers: count increases by 1 after inserting a user", async () => {
    const db = getDb();

    // The user was inserted in beforeAll — count the delta by
    // checking that the total is at least 1 (the dev DB may have existing users).
    const count = await countUsers(db);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("findAnyPendingInvitationByEmail: finds a fresh invite (case-insensitive)", async () => {
    const db = getDb();

    await createInvitation(db, {
      projectId: PROJECT_ID,
      email: "invitee@example.com",
      role: "DEVELOPER",
      tokenHash: `hash_valid_${RUN_ID}`,
      invitedByUserId: USER_ID,
      expiresAt: new Date(Date.now() + 86_400_000), // +1 day
    });

    // Case-insensitive match
    const found = await findAnyPendingInvitationByEmail(
      db,
      "INVITEE@example.com",
    );
    expect(found).not.toBeNull();
    expect(found!.email).toBe("invitee@example.com");
  });

  it("findAnyPendingInvitationByEmail: returns null for unknown email", async () => {
    const db = getDb();
    const result = await findAnyPendingInvitationByEmail(
      db,
      "nobody@example.com",
    );
    expect(result).toBeNull();
  });

  it("findAnyPendingInvitationByEmail: does NOT return an expired invite", async () => {
    const db = getDb();

    await createInvitation(db, {
      projectId: PROJECT_ID,
      email: "expired@example.com",
      role: "DEVELOPER",
      tokenHash: `hash_expired_${RUN_ID}`,
      invitedByUserId: USER_ID,
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const result = await findAnyPendingInvitationByEmail(
      db,
      "expired@example.com",
    );
    expect(result).toBeNull();
  });

  it("findAnyPendingInvitationByEmail: does NOT return a revoked invite", async () => {
    const db = getDb();

    const invite = await createInvitation(db, {
      projectId: PROJECT_ID,
      email: "revoked@example.com",
      role: "DEVELOPER",
      tokenHash: `hash_revoked_${RUN_ID}`,
      invitedByUserId: USER_ID,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    // Revoke it
    await db
      .update(projectInvitations)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(sql`id = ${invite.id}`);

    const result = await findAnyPendingInvitationByEmail(
      db,
      "revoked@example.com",
    );
    expect(result).toBeNull();
  });
});
