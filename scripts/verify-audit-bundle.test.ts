import { describe, expect, test } from "vitest";
import {
  AUDIT_CHAIN_FORMAT_V1,
  hashAuditRow,
  type AuditChainPayload,
} from "@rovenue/shared/audit-chain";
import fixture from "@rovenue/shared/audit-proof-bundle-fixture.json";
import { verifyAuditBundle } from "./verify-audit-bundle";

function entry(
  overrides: Partial<AuditChainPayload> & { id: string },
): AuditChainPayload & { id: string; rowHash: string } {
  // `id` is destructured off `overrides` before the spread below: `id`
  // is never part of `AuditChainPayload` and must never enter what gets
  // hashed (see apps/api/src/lib/audit.ts's `buildCanonicalPayload` and
  // audit-logs.proof.test.ts's `hashedRow`, both of which strip it the
  // same way) -- spreading `overrides` directly here would silently
  // leak `id` into `payload` (TS's excess-property check does not catch
  // properties introduced via a spread), producing a `rowHash` that
  // disagrees with what the real endpoint computes.
  const { id, ...payloadOverrides } = overrides;
  const payload: AuditChainPayload = {
    projectId: "prj_1",
    userId: "usr_1",
    action: "update",
    resource: "product",
    resourceId: "prd_1",
    before: null,
    after: { price: 1 },
    ipAddress: null,
    userAgent: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    prevHash: null,
    ...payloadOverrides,
  };
  return { ...payload, id, rowHash: hashAuditRow(payload) };
}

function chainOf(n: number) {
  const out: Array<ReturnType<typeof entry>> = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i += 1) {
    const e = entry({
      id: `aud_${i}`,
      prevHash: prev,
      createdAt: new Date(Date.UTC(2026, 8, 5, 0, 0, i)).toISOString(),
    });
    out.push(e);
    prev = e.rowHash;
  }
  return out;
}

function bundle(entries: ReturnType<typeof chainOf>) {
  return {
    formatVersion: AUDIT_CHAIN_FORMAT_V1,
    projectId: "prj_1",
    exportedAt: "2026-09-05T01:00:00.000Z",
    origin: null,
    truncated: false,
    tip: entries.length
      ? { rowHash: entries[entries.length - 1]!.rowHash, createdAt: entries[entries.length - 1]!.createdAt }
      : null,
    entries,
  };
}

describe("verifyAuditBundle", () => {
  test("accepts an intact chain", () => {
    const r = verifyAuditBundle(bundle(chainOf(5)));
    expect(r.ok).toBe(true);
    expect(r.entriesChecked).toBe(5);
  });

  test("names the entry whose payload was altered", () => {
    const entries = chainOf(5);
    // Tamper with the payload but leave rowHash untouched: this is what
    // an edited audit record looks like.
    entries[2] = { ...entries[2]!, after: { price: 999 } };
    const r = verifyAuditBundle(bundle(entries));
    expect(r.ok).toBe(false);
    expect(r.failure?.index).toBe(2);
    expect(r.failure?.entryId).toBe("aud_2");
    expect(r.failure?.reason).toBe("ROW_HASH_MISMATCH");
  });

  test("names the link when a prevHash is rewritten", () => {
    const entries = chainOf(5);
    // Re-hash so the row itself is self-consistent — only the link to
    // its predecessor is wrong. A verifier that checked row hashes
    // alone would pass this.
    const broken = { ...entries[3]!, prevHash: "0".repeat(64) };
    entries[3] = { ...broken, rowHash: hashAuditRow(broken) };
    const r = verifyAuditBundle(bundle(entries));
    expect(r.ok).toBe(false);
    expect(r.failure?.index).toBe(3);
    expect(r.failure?.reason).toBe("PREV_HASH_MISMATCH");
  });

  test("detects a removed entry", () => {
    const entries = chainOf(5);
    entries.splice(2, 1);
    // Deleting a row leaves the next row's prevHash pointing at a hash
    // that is no longer its predecessor.
    const r = verifyAuditBundle(bundle(entries));
    expect(r.ok).toBe(false);
    expect(r.failure?.reason).toBe("PREV_HASH_MISMATCH");
  });

  test("rejects an unknown format version rather than guessing", () => {
    const b = { ...bundle(chainOf(2)), formatVersion: "rovenue.audit-chain.v99" };
    expect(verifyAuditBundle(b).ok).toBe(false);
  });

  test("rejects an entry with no rowHash", () => {
    const entries = chainOf(3);
    // @ts-expect-error deliberately malformed
    entries[1] = { ...entries[1]!, rowHash: null };
    const r = verifyAuditBundle(bundle(entries));
    expect(r.failure?.reason).toBe("UNHASHED_ROW");
  });

  test("anchors a mid-chain segment against its declared origin", () => {
    const all = chainOf(5);
    const segment = all.slice(2);
    const b = {
      ...bundle(segment),
      origin: { rowHash: all[1]!.rowHash },
    };
    expect(verifyAuditBundle(b).ok).toBe(true);

    const wrongOrigin = { ...b, origin: { rowHash: "0".repeat(64) } };
    expect(verifyAuditBundle(wrongOrigin).ok).toBe(false);
  });

  test("an empty bundle verifies as ok with nothing checked", () => {
    const r = verifyAuditBundle(bundle([]));
    expect(r.ok).toBe(true);
    expect(r.entriesChecked).toBe(0);
  });

  test("truncated mirrors the bundle's own flag", () => {
    const truncatedBundle = { ...bundle(chainOf(3)), truncated: true };
    const r = verifyAuditBundle(truncatedBundle);
    // A truncated-but-intact bundle is still ok: true -- truncation is a
    // legitimate export state, not tampering.
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
  });

  test("a bundle missing `truncated` entirely is treated as truncated: true", () => {
    const { truncated: _truncated, ...rest } = bundle(chainOf(2));
    const r = verifyAuditBundle(rest);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
  });

  test("accepts the real bundle the /proof endpoint assembles", () => {
    // Ties the offline verifier to the actual shape apps/api emits --
    // see apps/api/src/routes/dashboard/audit-logs.proof.test.ts, which
    // asserts the endpoint's assembled bundle deep-equals this same
    // fixture. If the endpoint's assembly ever drifts from this format,
    // that test goes red; if the verifier ever drifts, this one does.
    const r = verifyAuditBundle(fixture);
    expect(r.ok).toBe(true);
  });
});
