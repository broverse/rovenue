import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { integrationConnections } from "./schema";

describe("integrationConnections table", () => {
  it("has every column from spec §3.1", () => {
    const cols = Object.keys(getTableColumns(integrationConnections));
    expect(cols.sort()).toEqual(
      [
        "id", "projectId", "providerId", "displayName",
        "credentialsCipher", "credentialsHint",
        "enabledEvents", "eventMapping",
        "actionSource", "testEventCode",
        "isEnabled", "lastValidatedAt", "lastError", "lastBackfillAt",
        "createdAt", "updatedAt",
      ].sort(),
    );
  });

  it("infers expected select / insert types", () => {
    type Row = typeof integrationConnections.$inferSelect;
    const sample: Row = {
      id: "c1", projectId: "p1", providerId: "META_CAPI", displayName: "Test",
      credentialsCipher: "v1:abc", credentialsHint: "Pixel 1234",
      enabledEvents: ["revenue.RENEWAL"], eventMapping: {},
      actionSource: "app", testEventCode: null,
      isEnabled: false, lastValidatedAt: null, lastError: null, lastBackfillAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    expect(sample.providerId).toBe("META_CAPI");
  });
});
