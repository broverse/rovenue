// =============================================================
// recipient resolver — integration tests (real Postgres)
// =============================================================

import { describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { getDb, drizzle as drizzleNs } from "@rovenue/db";
import { resolveRecipients } from "./recipient-resolver";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

const db = getDb();
const schema = drizzleNs.schema;

async function seedUser() {
  const id = createId();
  const now = new Date();
  await db.insert(schema.user).values({
    id,
    name: `user-${id}`,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedProject() {
  const [row] = await db
    .insert(schema.projects)
    .values({ name: `proj-${createId()}` })
    .returning();
  if (!row) throw new Error("seedProject: no row");
  return row.id;
}

type Role = "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT";

async function addMember(projectId: string, userId: string, role: Role) {
  await db
    .insert(schema.projectMembers)
    .values({ projectId, userId, role });
}

describe("resolveRecipients", () => {
  it("returns explicit recipients as-is", async () => {
    const r = await resolveRecipients(db, {
      eventKey: "security.signin.new_device",
      recipients: ["u1"],
    });
    expect(r).toEqual(["u1"]);
  });

  it("self-scoped event without explicit recipients throws", async () => {
    await expect(
      resolveRecipients(db, { eventKey: "security.signin.new_device" }),
    ).rejects.toThrow(/self.*recipients/i);
  });

  it("project-scoped event without projectId throws", async () => {
    await expect(
      resolveRecipients(db, { eventKey: "revenue.anomaly.detected" }),
    ).rejects.toThrow(/projectId/i);
  });

  it("project_roles returns only members in the listed roles", async () => {
    const projectId = await seedProject();
    const [owner, admin, dev, growth, support] = await Promise.all([
      seedUser(),
      seedUser(),
      seedUser(),
      seedUser(),
      seedUser(),
    ]);
    await addMember(projectId, owner!, "OWNER");
    await addMember(projectId, admin!, "ADMIN");
    await addMember(projectId, dev!, "DEVELOPER");
    await addMember(projectId, growth!, "GROWTH");
    await addMember(projectId, support!, "CUSTOMER_SUPPORT");

    // revenue.anomaly.detected → OWNER + ADMIN + GROWTH
    const r = await resolveRecipients(db, {
      eventKey: "revenue.anomaly.detected",
      projectId,
    });
    expect(new Set(r)).toEqual(new Set([owner, admin, growth]));
  });

  it("project_members returns every member regardless of role", async () => {
    const projectId = await seedProject();
    const [owner, admin, dev] = await Promise.all([
      seedUser(),
      seedUser(),
      seedUser(),
    ]);
    await addMember(projectId, owner!, "OWNER");
    await addMember(projectId, admin!, "ADMIN");
    await addMember(projectId, dev!, "DEVELOPER");

    // revenue.milestone.hit → project_members
    const r = await resolveRecipients(db, {
      eventKey: "revenue.milestone.hit",
      projectId,
    });
    expect(new Set(r)).toEqual(new Set([owner, admin, dev]));
  });

  it("workspace_owner returns only the project OWNER(s)", async () => {
    const projectId = await seedProject();
    const [owner, admin] = await Promise.all([seedUser(), seedUser()]);
    await addMember(projectId, owner!, "OWNER");
    await addMember(projectId, admin!, "ADMIN");

    // billing.invoice.failed → workspace_owner
    const r = await resolveRecipients(db, {
      eventKey: "billing.invoice.failed",
      projectId,
    });
    expect(r).toEqual([owner]);
  });

  it("returns empty when the project has no members in the role set", async () => {
    const projectId = await seedProject();
    const dev = await seedUser();
    await addMember(projectId, dev, "DEVELOPER");

    // revenue.anomaly.detected wants OWNER/ADMIN/GROWTH — dev not in set
    const r = await resolveRecipients(db, {
      eventKey: "revenue.anomaly.detected",
      projectId,
    });
    expect(r).toEqual([]);
  });
});
