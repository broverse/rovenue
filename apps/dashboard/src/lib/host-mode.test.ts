import { describe, expect, it } from "vitest";
import { computeHostMode } from "./host-mode";

describe("computeHostMode", () => {
  it("defaults to self-hosted when VITE_HOST_MODE is unset", () => {
    const m = computeHostMode({ VITE_HOST_MODE: undefined, VITE_ALLOW_REGISTRATION: undefined });
    expect(m.isSelfHosted).toBe(true);
    expect(m.isCloud).toBe(false);
    expect(m.billingEnabled).toBe(false);
    expect(m.byokAllowed).toBe(true);
    expect(m.registrationOpen).toBe(false);
  });

  it("defaults to self-hosted when VITE_HOST_MODE is empty string", () => {
    const m = computeHostMode({ VITE_HOST_MODE: "", VITE_ALLOW_REGISTRATION: "" });
    expect(m.isSelfHosted).toBe(true);
    expect(m.billingEnabled).toBe(false);
    expect(m.byokAllowed).toBe(true);
    expect(m.registrationOpen).toBe(false);
  });

  it("resolves cloud mode when VITE_HOST_MODE=cloud", () => {
    const m = computeHostMode({ VITE_HOST_MODE: "cloud" });
    expect(m.isCloud).toBe(true);
    expect(m.isSelfHosted).toBe(false);
    expect(m.billingEnabled).toBe(true);
    expect(m.byokAllowed).toBe(false);
    // registration defaults open in cloud when VITE_ALLOW_REGISTRATION unset
    expect(m.registrationOpen).toBe(true);
  });

  it("self-hosted with explicit VITE_ALLOW_REGISTRATION=true opens registration", () => {
    const m = computeHostMode({ VITE_HOST_MODE: "self", VITE_ALLOW_REGISTRATION: "true" });
    expect(m.isSelfHosted).toBe(true);
    expect(m.registrationOpen).toBe(true);
  });

  it("self-hosted with VITE_ALLOW_REGISTRATION=false keeps registration closed", () => {
    const m = computeHostMode({ VITE_HOST_MODE: "self", VITE_ALLOW_REGISTRATION: "false" });
    expect(m.isSelfHosted).toBe(true);
    expect(m.registrationOpen).toBe(false);
  });

  it("cloud with explicit VITE_ALLOW_REGISTRATION=false closes registration", () => {
    const m = computeHostMode({ VITE_HOST_MODE: "cloud", VITE_ALLOW_REGISTRATION: "false" });
    expect(m.isCloud).toBe(true);
    expect(m.registrationOpen).toBe(false);
  });
});
