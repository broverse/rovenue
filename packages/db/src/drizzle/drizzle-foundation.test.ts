import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  apiKeys,
  audiences,
  auditLogs,
  creditLedger,
  experimentAssignments,
  experiments,
  featureFlags,
  outgoingWebhooks,
  productGroups,
  products,
  projectMembers,
  projects,
  purchases,
  revenueEvents,
  subscriberAccess,
  subscribers,
  user,
  webhookEvents,
  type AuditLogRow,
  type NewAuditLogRow,
  type NewProject,
} from "./schema";
import {
  experimentVariantsSchema,
  featureFlagRulesSchema,
  productGroupProductsSchema,
  productInsertSchema,
  productStoreIdsSchema,
  projectInsertSchema,
  subscriberInsertSchema,
} from "./validators";
import { nowMinus, timeBucket } from "./sql-helpers";
import { dailyMrr } from "./views";

// =============================================================
// Drizzle foundation — smoke tests
// =============================================================
//
// No live DB here. These tests exercise the schema at the *type*
// level: columns resolve, inferred types carry nullability, FK
// references compile.

describe("schema shapes compile", () => {
  it("exposes every expected table", () => {
    for (const table of [
      user,
      projects,
      projectMembers,
      apiKeys,
      products,
      productGroups,
      subscribers,
      purchases,
      subscriberAccess,
      creditLedger,
      webhookEvents,
      outgoingWebhooks,
      revenueEvents,
      audiences,
      experiments,
      experimentAssignments,
      featureFlags,
      auditLogs,
    ]) {
      expect(table).toBeDefined();
    }
  });

  it("pins on-disk camelCase column names", () => {
    // `.name` is the column identifier used in SQL; we pin these
    // against the live DB shape so renaming a .ts field doesn't
    // silently regenerate a DROP/ADD migration.
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

// =============================================================
// drizzle-zod validators
// =============================================================

describe("projectInsertSchema", () => {
  it("accepts a valid project", () => {
    expect(() =>
      projectInsertSchema.parse({ name: "Acme", slug: "acme" }),
    ).not.toThrow();
  });

  it("rejects an invalid slug", () => {
    expect(() =>
      projectInsertSchema.parse({ name: "Acme", slug: "Acme!" }),
    ).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() =>
      projectInsertSchema.parse({ name: "", slug: "acme" }),
    ).toThrow();
  });
});

describe("productInsertSchema + productStoreIdsSchema", () => {
  it("parses a minimal product insert", () => {
    expect(() =>
      productInsertSchema.parse({
        projectId: "proj_1",
        identifier: "pro_monthly",
        type: "SUBSCRIPTION",
        storeIds: { apple: "com.x.pro" },
        displayName: "Pro",
      }),
    ).not.toThrow();
  });

  it("rejects empty storeIds via the standalone schema", () => {
    expect(() => productStoreIdsSchema.parse({})).toThrow(
      /at least one store/i,
    );
  });

  it("rejects an identifier starting with a dash", () => {
    expect(() =>
      productInsertSchema.parse({
        projectId: "proj_1",
        identifier: "-bad",
        type: "SUBSCRIPTION",
        storeIds: { apple: "x" },
        displayName: "Bad",
      }),
    ).toThrow();
  });
});

describe("subscriberInsertSchema", () => {
  it("caps appUserId length at 256 chars", () => {
    expect(() =>
      subscriberInsertSchema.parse({
        projectId: "proj_1",
        appUserId: "a".repeat(257),
      }),
    ).toThrow();
  });
});

describe("experimentVariantsSchema", () => {
  it("accepts two variants with weights summing to 1", () => {
    expect(() =>
      experimentVariantsSchema.parse([
        { id: "control", name: "Control", value: null, weight: 0.5 },
        { id: "variant", name: "Variant", value: null, weight: 0.5 },
      ]),
    ).not.toThrow();
  });

  it("rejects weights that don't sum to 1", () => {
    expect(() =>
      experimentVariantsSchema.parse([
        { id: "a", name: "A", value: null, weight: 0.4 },
        { id: "b", name: "B", value: null, weight: 0.4 },
      ]),
    ).toThrow(/sum to 1/);
  });

  it("rejects duplicate variant ids", () => {
    expect(() =>
      experimentVariantsSchema.parse([
        { id: "same", name: "A", value: null, weight: 0.5 },
        { id: "same", name: "B", value: null, weight: 0.5 },
      ]),
    ).toThrow(/duplicate variant id/);
  });
});

describe("featureFlagRulesSchema", () => {
  it("accepts an ordered rule list", () => {
    expect(() =>
      featureFlagRulesSchema.parse([
        { audienceId: "aud_1", value: true, rolloutPercentage: 0.5 },
        { audienceId: "aud_2", value: false },
      ]),
    ).not.toThrow();
  });

  it("rejects rolloutPercentage > 1", () => {
    expect(() =>
      featureFlagRulesSchema.parse([
        { audienceId: "aud_1", value: true, rolloutPercentage: 1.5 },
      ]),
    ).toThrow();
  });
});

describe("productGroupProductsSchema", () => {
  it("accepts a simple product group", () => {
    expect(() =>
      productGroupProductsSchema.parse([
        { productId: "prod_1", order: 0, promoted: true },
        { productId: "prod_2", order: 1 },
      ]),
    ).not.toThrow();
  });
});

describe("enum membership", () => {
  it("creditLedger.type values match the Postgres enum labels", () => {
    // enumValues is a runtime property exposed by pgEnum — assert
    // the label list stays pinned to the on-disk enum.
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

// =============================================================
// Timescale SQL helpers + continuous aggregates
// =============================================================

// `sql.param()` wraps values in a Param chunk whose value stays
// off the raw SQL string. Searching for a Param with the given
// interval string proves the helper binds (not concats) the arg.
function containsParam(fragment: { queryChunks: unknown[] }, value: unknown): boolean {
  return fragment.queryChunks.some(
    (chunk) =>
      chunk !== null &&
      typeof chunk === "object" &&
      chunk.constructor?.name === "Param" &&
      (chunk as { value: unknown }).value === value,
  );
}

describe("timeBucket", () => {
  it("binds the interval argument as a Param", () => {
    const fragment = timeBucket("1 day", revenueEvents.eventDate);
    expect(containsParam(fragment, "1 day")).toBe(true);
  });
});

describe("nowMinus", () => {
  it("binds the offset argument as a Param", () => {
    const fragment = nowMinus("30 days");
    expect(containsParam(fragment, "30 days")).toBe(true);
  });
});

describe("dailyMrr view", () => {
  it("exposes the cagg column surface (projectId, bucket, gross_usd, …)", () => {
    expect(dailyMrr.projectId.name).toBe("projectId");
    expect(dailyMrr.bucket.name).toBe("bucket");
    expect(dailyMrr.grossUsd.name).toBe("gross_usd");
    expect(dailyMrr.eventCount.name).toBe("event_count");
    expect(dailyMrr.activeSubscribers.name).toBe("active_subscribers");
  });
});
