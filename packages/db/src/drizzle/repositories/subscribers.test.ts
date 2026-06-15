// =============================================================
// upsertSubscriber — unit tests for appleAppAccountToken
// preservation semantics on the ON CONFLICT DO UPDATE branch
// =============================================================
//
// Task 9 of the Refund Shield backend persists the Apple
// `appAccountToken` (UUID) onto the `subscribers` row so the
// CONSUMPTION_REQUEST flow can map a notification back to its
// owning subscriber. The load-bearing rule is: a later
// notification that arrives WITHOUT an `appAccountToken` must
// NOT clobber a previously captured token. The repo enforces
// this by OMITTING the column from the UPDATE SET when
// `input.appleAppAccountToken == null`.
//
// These tests pin that contract structurally — they assert
// shape of the `set` object passed to Drizzle's
// `onConflictDoUpdate({ target, set })` without standing up
// Postgres. The end-to-end test in
// `apps/api/src/services/apple/apple-webhook.app-account-token.test.ts`
// only exercises the surrounding webhook plumbing and (per Task 9
// code review) does not actually traverse the UPDATE branch of
// this upsert, hence the dedicated coverage here.

import { describe, expect, it, vi } from "vitest";
import { upsertSubscriber } from "./subscribers";

// ---------------------------------------------------------------
// Drizzle fluent-chain test double
//
// Mirrors only the calls `upsertSubscriber` makes:
//   db.insert(...).values(...).onConflictDoUpdate({...}).returning()
// The `setSpy` captures whatever object the production code
// passed as `set`, which is the artifact under test.
// ---------------------------------------------------------------

function makeFakeDb(returningRow: Record<string, unknown> = { id: "sub_1" }) {
  const setSpy = vi.fn<[Record<string, unknown>], void>();
  const valuesSpy =
    vi.fn<[Record<string, unknown>], void>();
  const fakeDb = {
    insert: vi.fn(() => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        valuesSpy(vals);
        return {
          onConflictDoUpdate: vi.fn(
            (cfg: { set: Record<string, unknown> }) => {
              setSpy(cfg.set);
              return {
                returning: vi.fn(async () => [returningRow]),
              };
            },
          ),
        };
      }),
    })),
  };
  // The repo signature is typed against the real Db; the cast lets
  // us hand it our duck-typed shim. The behaviour under test lives
  // entirely in the chain above so the loose typing here is safe.
  return { fakeDb: fakeDb as unknown as Parameters<typeof upsertSubscriber>[0], setSpy, valuesSpy };
}

describe("upsertSubscriber — appleAppAccountToken preservation on UPDATE", () => {
  it("OMITS appleAppAccountToken from UPDATE SET when the input field is null", async () => {
    const { fakeDb, setSpy, valuesSpy } = makeFakeDb();

    await upsertSubscriber(fakeDb, {
      projectId: "proj_1",
      rovenueId: "user_1",
      appUserId: "user_1",
      appleAppAccountToken: null,
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    const setArg = setSpy.mock.calls[0]?.[0] ?? {};
    // The preservation contract: column NOT present in SET, so
    // the existing column value in the row is left untouched.
    expect(setArg).not.toHaveProperty("appleAppAccountToken");
    // Sanity: `lastSeenAt` is always written on touch.
    expect(setArg).toHaveProperty("lastSeenAt");

    // VALUES still carries the null for the insert side — that's
    // fine, only the UPDATE side is preservation-sensitive.
    const valuesArg = valuesSpy.mock.calls[0]?.[0] ?? {};
    expect(valuesArg).toHaveProperty("appleAppAccountToken", null);
  });

  it("OMITS appleAppAccountToken from UPDATE SET when the input field is undefined", async () => {
    // The webhook path can also call upsert WITHOUT passing the
    // field at all (legacy callers, non-token-binding flows). Same
    // preservation guarantee must hold.
    const { fakeDb, setSpy } = makeFakeDb();

    await upsertSubscriber(fakeDb, {
      projectId: "proj_1",
      rovenueId: "user_1",
      appUserId: "user_1",
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    const setArg = setSpy.mock.calls[0]?.[0] ?? {};
    expect(setArg).not.toHaveProperty("appleAppAccountToken");
  });

  it("INCLUDES appleAppAccountToken in UPDATE SET when the input field is a non-empty string", async () => {
    const { fakeDb, setSpy, valuesSpy } = makeFakeDb();
    const token = "550e8400-e29b-41d4-a716-446655440000";

    await upsertSubscriber(fakeDb, {
      projectId: "proj_1",
      rovenueId: "user_1",
      appUserId: "user_1",
      appleAppAccountToken: token,
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    const setArg = setSpy.mock.calls[0]?.[0] ?? {};
    // When the caller supplies a token the UPDATE side rewrites
    // the column verbatim. This is the "first capture" path —
    // initial Apple notification carrying `appAccountToken` for
    // a row that pre-exists from an earlier non-Apple touch.
    expect(setArg.appleAppAccountToken).toBe(token);
    // VALUES side is symmetric.
    const valuesArg = valuesSpy.mock.calls[0]?.[0] ?? {};
    expect(valuesArg.appleAppAccountToken).toBe(token);
  });

  it("only writes updateAttributes into SET when the caller explicitly provides them", async () => {
    // Companion shape-pin: `updateAttributes` follows the same
    // "omit when not provided" convention so a notification that
    // only touches `lastSeenAt` doesn't blow away the existing
    // attributes JSON. Pinning this here makes the SET-omission
    // pattern as a whole regression-proof, not just the token
    // column.
    const { fakeDb, setSpy } = makeFakeDb();

    await upsertSubscriber(fakeDb, {
      projectId: "proj_1",
      rovenueId: "user_1",
      appUserId: "user_1",
    });

    const setArg = setSpy.mock.calls[0]?.[0] ?? {};
    expect(setArg).not.toHaveProperty("attributes");
  });
});
