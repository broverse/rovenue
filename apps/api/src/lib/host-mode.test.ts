import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env";
import {
  isBillingEnabled,
  isByokAllowed,
  isCloud,
  isSelfHosted,
  quotasUnlimited,
  registrationOpen,
} from "./host-mode";

const original = { HOST_MODE: env.HOST_MODE, ALLOW_REGISTRATION: env.ALLOW_REGISTRATION };
afterEach(() => {
  env.HOST_MODE = original.HOST_MODE;
  env.ALLOW_REGISTRATION = original.ALLOW_REGISTRATION;
});

describe("host-mode flags", () => {
  it("self: billing off, unlimited, byok on, registration closed by default", () => {
    env.HOST_MODE = "self";
    env.ALLOW_REGISTRATION = undefined;
    expect(isSelfHosted()).toBe(true);
    expect(isCloud()).toBe(false);
    expect(isBillingEnabled()).toBe(false);
    expect(quotasUnlimited()).toBe(true);
    expect(isByokAllowed()).toBe(true);
    expect(registrationOpen()).toBe(false);
  });

  it("cloud: billing on, quotas enforced, no byok, registration open by default", () => {
    env.HOST_MODE = "cloud";
    env.ALLOW_REGISTRATION = undefined;
    expect(isBillingEnabled()).toBe(true);
    expect(quotasUnlimited()).toBe(false);
    expect(isByokAllowed()).toBe(false);
    expect(registrationOpen()).toBe(true);
  });

  it("explicit ALLOW_REGISTRATION overrides the derived default", () => {
    env.HOST_MODE = "self";
    env.ALLOW_REGISTRATION = true;
    expect(registrationOpen()).toBe(true);
    env.HOST_MODE = "cloud";
    env.ALLOW_REGISTRATION = false;
    expect(registrationOpen()).toBe(false);
  });
});
