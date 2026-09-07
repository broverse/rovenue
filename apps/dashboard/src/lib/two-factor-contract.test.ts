// Contract test for the shape better-auth's `/two-factor/enable` actually
// returns, read off the INSTALLED dependency's own types.
//
// Why this exists: `routes/_authed/account/security.tsx` gated its TOTP
// enrolment dialog on `res.data.method !== "totp"`. That discriminator only
// exists in better-auth 1.7. This workspace is pinned to the 1.6 patch line
// (root package.json; commit 633894b9), where the endpoint returns a bare
// `{ totpURI, backupCodes }` — so the guard read `undefined !== "totp"`,
// always true, and REJECTED EVERY ENROLMENT. The QR and recovery codes never
// rendered. Nothing caught it: 2FA has no behavioural tests, and `tsc` only
// went red because the property is absent from the 1.6 type.
//
// A test against a hand-written mock of `authClient` would not have caught it
// either — it would assert whatever shape the mock's author believed in, and
// that belief was the bug. So this asserts against the dependency itself, at
// type level, checked by the `tsc --noEmit` gate this package already has.
//
// The type MUST be derived from a real call expression. `ReturnType<typeof
// authClient.twoFactor.enable>` resolves to `any` here (the client's method is
// generic over its options, and ReturnType collapses it), which would make
// every assertion below silently vacuous — verified by probing with an
// `IsAny` check. That is exactly the failure this file exists to prevent, so
// the derivation is load-bearing: do not "simplify" it back to ReturnType.
//
// If better-auth is upgraded to 1.7+, `method` becomes real and the response
// becomes a discriminated union whose non-TOTP arm carries no `totpURI`. That
// upgrade SHOULD break this file — when it does, re-check security.tsx's
// precondition before deleting anything here.

import { describe, expect, it } from "vitest";
import { authClient } from "./auth";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function callShape() {
  return authClient.twoFactor.enable({});
}
type EnableData = NonNullable<Awaited<ReturnType<typeof callShape>>["data"]>;

// Fails the build if the derivation above ever collapses to `any` again,
// which would make every assertion in this file pass without checking
// anything.
type IsAny<T> = 0 extends 1 & T ? true : false;
const derivationIsNotAny: IsAny<EnableData> extends false ? true : never = true;

describe("better-auth two-factor enable response contract", () => {
  it("derives a real type, not `any`", () => {
    expect(derivationIsNotAny).toBe(true);
  });

  it("carries the two fields the TOTP dialog renders from", () => {
    const shape = (data: EnableData) => ({
      totpURI: data.totpURI satisfies string,
      backupCodes: data.backupCodes satisfies string[],
    });
    expect(typeof shape).toBe("function");
  });

  it("has no `method` discriminator on the pinned major", () => {
    // The actual defect, pinned. If this stops holding, better-auth has moved
    // to the 1.7 union and security.tsx's precondition must be re-examined
    // rather than left to silently change meaning.
    type HasMethod = "method" extends keyof EnableData ? true : false;
    const methodIsAbsent: HasMethod extends false ? true : never = true;
    expect(methodIsAbsent).toBe(true);
  });
});
