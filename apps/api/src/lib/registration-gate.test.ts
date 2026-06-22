import { describe, expect, it } from "vitest";
import { isRegistrationAllowed } from "./registration-gate";

describe("isRegistrationAllowed", () => {
  it("allows the very first user regardless of policy", () => {
    expect(
      isRegistrationAllowed({
        userCount: 0,
        registrationOpen: false,
        hasPendingInvite: false,
      }),
    ).toBe(true);
  });
  it("allows anyone when registration is open", () => {
    expect(
      isRegistrationAllowed({
        userCount: 5,
        registrationOpen: true,
        hasPendingInvite: false,
      }),
    ).toBe(true);
  });
  it("allows an invited user when registration is closed", () => {
    expect(
      isRegistrationAllowed({
        userCount: 5,
        registrationOpen: false,
        hasPendingInvite: true,
      }),
    ).toBe(true);
  });
  it("rejects an uninvited user when registration is closed", () => {
    expect(
      isRegistrationAllowed({
        userCount: 5,
        registrationOpen: false,
        hasPendingInvite: false,
      }),
    ).toBe(false);
  });
});
