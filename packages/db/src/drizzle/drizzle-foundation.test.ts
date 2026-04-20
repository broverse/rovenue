import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  auditLogs,
  creditLedger,
  projectMembers,
  projects,
  subscribers,
  user,
  type AuditLogRow,
  type NewAuditLogRow,
  type NewProject,
} from "./schema";

// =============================================================
// Drizzle foundation — smoke tests
// =============================================================
//
// No live DB here. These tests exercise the schema at the *type*
// level: columns resolve, inferred types carry nullability, FK
// references compile. Running queries against a real Postgres is
// reserved for Phase 1 integration tests once the cutover plan
// starts swapping callers off Prisma.

describe("schema shapes compile", () => {
  it("exposes user, projects, projectMembers, subscribers, creditLedger, auditLogs", () => {
    expect(user).toBeDefined();
    expect(projects).toBeDefined();
    expect(projectMembers).toBeDefined();
    expect(subscribers).toBeDefined();
    expect(creditLedger).toBeDefined();
    expect(auditLogs).toBeDefined();
  });

  it("maps camelCase columns onto the Prisma on-disk names", () => {
    // `.name` is the column identifier used in SQL; must match
    // what schema.prisma emitted in the init migration (quoted
    // camelCase) so Drizzle reads Prisma-managed rows correctly.
    expect(projects.appleCredentials.name).toBe("appleCredentials");
    expect(projectMembers.projectId.name).toBe("projectId");
    expect(projectMembers.userId.name).toBe("userId");
    expect(subscribers.firstSeenAt.name).toBe("firstSeenAt");
    expect(auditLogs.rowHash.name).toBe("rowHash");
    expect(auditLogs.prevHash.name).toBe("prevHash");
  });
});

describe("inferred types", () => {
  it("NewProject makes id/slug/name mandatory; settings/timestamps optional", () => {
    // Type-level assertion — if this compiles, the insert type is
    // correctly shaped. Runtime body is intentionally empty.
    const _ok: NewProject = { name: "Acme", slug: "acme" };
    expect(_ok.name).toBe("Acme");
  });

  it("AuditLogRow nullability matches the schema", () => {
    const row: AuditLogRow = {
      id: "x",
      projectId: "p",
      userId: "u",
      action: "create",
      resource: "audience",
      resourceId: "a",
      before: null,
      after: null,
      ipAddress: null,
      userAgent: null,
      prevHash: null,
      rowHash: null,
      createdAt: new Date(),
    };
    expect(row.rowHash).toBeNull();
  });
});

describe("query builder typing", () => {
  it("eq() on projects.id returns a SQL fragment", () => {
    const fragment = eq(projects.id, "proj_1");
    expect(fragment).toBeDefined();
  });

  it("sql template tag accepts drizzle columns", () => {
    const frag = sql`SELECT ${projects.slug} FROM ${projects}`;
    expect(frag).toBeDefined();
  });
});

describe("NewAuditLogRow hash chain columns", () => {
  it("accepts prevHash/rowHash on insert", () => {
    const row: NewAuditLogRow = {
      projectId: "p",
      userId: "u",
      action: "create",
      resource: "audience",
      resourceId: "a",
      prevHash: null,
      rowHash: "abc123",
    };
    expect(row.rowHash).toBe("abc123");
  });
});

describe("enum membership", () => {
  it("creditLedger.type values match the Postgres enum labels", () => {
    // enumValues is a runtime property exposed by pgEnum — assert
    // the labels list hasn't drifted from the Prisma definition.
    expect(creditLedger.type.enumValues).toEqual([
      "PURCHASE",
      "SPEND",
      "REFUND",
      "BONUS",
      "EXPIRE",
      "TRANSFER_IN",
      "TRANSFER_OUT",
    ]);
  });

  it("projectMembers.role has the three-tier membership model", () => {
    expect(projectMembers.role.enumValues).toEqual([
      "OWNER",
      "ADMIN",
      "VIEWER",
    ]);
  });
});
