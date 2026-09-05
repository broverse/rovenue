import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  AUDIT_CHAIN_FORMAT_V1,
  canonicalJSON,
  hashAuditRow,
  type AuditChainPayload,
} from "./audit-chain";

// A local copy of the ORIGINAL implementation, kept verbatim from
// apps/api/src/lib/audit.ts as it stood before extraction. This exists
// so the test compares the new encoder against the real previous
// behaviour rather than against itself.
function originalCanonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(originalCanonicalJSON).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${originalCanonicalJSON(obj[k])}`)
    .join(",")}}`;
}

const SAMPLES: unknown[] = [
  null,
  undefined,
  0,
  -0,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  "quotes \" and \\ backslashes",
  "unicode ✓ ü",
  true,
  [],
  [1, "two", null, { b: 1, a: 2 }],
  { z: 1, a: 2, m: 3 },
  { nested: { deep: { deeper: [1, { k: null }] } } },
  { "key with spaces": 1, "": 2 },
];

describe("canonicalJSON", () => {
  test.each(SAMPLES.map((s, i) => [i, s]))(
    "sample %i encodes byte-identically to the original implementation",
    (_i, sample) => {
      expect(canonicalJSON(sample)).toBe(originalCanonicalJSON(sample));
    },
  );

  test("object key order does not affect the encoding", () => {
    // The whole chain rests on this: two engines building the same
    // object in different orders must hash identically.
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
  });
});

describe("hashAuditRow", () => {
  const payload: AuditChainPayload = {
    projectId: "prj_1",
    userId: "usr_1",
    action: "update",
    resource: "product",
    resourceId: "prd_1",
    before: { price: 1 },
    after: { price: 2 },
    ipAddress: "1.2.3.4",
    userAgent: "test",
    createdAt: "2026-09-05T00:00:00.000Z",
    prevHash: null,
  };

  test("is the sha256 hex digest of the canonical form", () => {
    const expected = createHash("sha256")
      .update(originalCanonicalJSON(payload))
      .digest("hex");
    expect(hashAuditRow(payload)).toBe(expected);
  });

  test("changing any single field changes the hash", () => {
    const base = hashAuditRow(payload);
    const mutations: Array<Partial<AuditChainPayload>> = [
      { projectId: "prj_2" },
      { userId: null },
      { action: "delete" },
      { resource: "offering" },
      { resourceId: "prd_2" },
      { before: { price: 99 } },
      { after: null },
      { ipAddress: null },
      { userAgent: "other" },
      { createdAt: "2026-09-05T00:00:01.000Z" },
      { prevHash: "abc" },
    ];
    for (const m of mutations) {
      expect(hashAuditRow({ ...payload, ...m })).not.toBe(base);
    }
  });
});

describe("AUDIT_CHAIN_FORMAT_V1", () => {
  test("is a stable identifier", () => {
    // Written into every bundle. Changing it silently would make old
    // bundles unverifiable, so pin the literal.
    expect(AUDIT_CHAIN_FORMAT_V1).toBe("rovenue.audit-chain.v1");
  });
});
