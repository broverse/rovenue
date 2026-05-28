import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(__dirname, "0053_integrations_framework.sql");

describe("0053_integrations_framework.sql", () => {
  it("file exists", () => {
    expect(existsSync(FILE)).toBe(true);
  });
  it("creates both tables and the partman parent", () => {
    const sql = readFileSync(FILE, "utf8");
    expect(sql).toContain('CREATE TYPE "public"."IntegrationProvider"');
    expect(sql).toContain('CREATE TABLE "integration_connections"');
    expect(sql).toContain('CREATE TABLE "integration_deliveries"');
    expect(sql).toContain("PARTITION BY RANGE (created_at)");
    expect(sql).toContain("partman.create_parent");
    expect(sql).toContain("p_premake => 7");
    expect(sql).toContain("retention='30 days'");
    expect(sql).toContain("integration_connections_project_provider_uidx");
    expect(sql).toContain("integration_deliveries_dedupe_uidx");
  });
});
