import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { integrationDeliveries } from "./schema";

describe("integrationDeliveries table", () => {
  it("has spec §3.2 columns", () => {
    const cols = Object.keys(getTableColumns(integrationDeliveries));
    expect(cols.sort()).toEqual(
      [
        "id", "connectionId", "projectId", "providerId", "outboxEventId",
        "eventKey", "providerEvent", "status", "attempt",
        "skipReason", "httpStatus", "responseBody", "errorMessage",
        "createdAt", "updatedAt",
      ].sort(),
    );
  });

  it("status column is the IntegrationDeliveryStatus enum", () => {
    type Row = typeof integrationDeliveries.$inferSelect;
    const row: Row = {
      id: "d1", connectionId: "c1", projectId: "p1", providerId: "META_CAPI",
      outboxEventId: "o1", eventKey: "revenue.RENEWAL", providerEvent: "Purchase",
      status: "pending", attempt: 0,
      skipReason: null, httpStatus: null, responseBody: null, errorMessage: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    expect(row.status).toBe("pending");
  });
});
