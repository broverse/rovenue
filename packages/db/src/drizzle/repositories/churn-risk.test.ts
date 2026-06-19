import { describe, expect, it } from "vitest";
import { churnRiskScore } from "./churn-risk";

const RECENT = new Date("2026-06-19T00:00:00Z");
const NOW = new Date("2026-06-19T12:00:00Z");

function input(overrides: Partial<Parameters<typeof churnRiskScore>[0]> = {}) {
  return {
    purchaseCount: 1,
    hasActiveAccess: true,
    inGracePeriod: false,
    autoRenewOff: false,
    lastSeenAt: RECENT,
    now: NOW,
    ...overrides,
  };
}

describe("churnRiskScore", () => {
  it("returns 0 for a subscriber who never purchased, regardless of inactivity", () => {
    const longAgo = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(churnRiskScore(input({ purchaseCount: 0, hasActiveAccess: false, lastSeenAt: longAgo }))).toBe(0);
  });

  it("scores a healthy, recently-active paying customer at 0 (green)", () => {
    expect(churnRiskScore(input())).toBe(0);
  });

  it("flags a churned customer (lost access after paying)", () => {
    // 55 base, recent activity → amber
    expect(churnRiskScore(input({ hasActiveAccess: false }))).toBe(55);
  });

  it("escalates a churned + long-inactive customer into the red band", () => {
    const old = new Date(NOW.getTime() - 31 * 86_400_000);
    expect(churnRiskScore(input({ hasActiveAccess: false, lastSeenAt: old }))).toBe(85);
  });

  it("flags an in-grace-period (billing failing) customer", () => {
    expect(churnRiskScore(input({ inGracePeriod: true }))).toBe(45);
  });

  it("flags auto-renew-off (cancellation intent) on an active sub", () => {
    expect(churnRiskScore(input({ autoRenewOff: true }))).toBe(35);
  });

  it("prioritises churned over grace/auto-renew (mutually exclusive)", () => {
    expect(
      churnRiskScore(input({ hasActiveAccess: false, inGracePeriod: true, autoRenewOff: true })),
    ).toBe(55);
  });

  it("adds graduated inactivity points (7/14/30 day thresholds)", () => {
    const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    expect(churnRiskScore(input({ autoRenewOff: true, lastSeenAt: days(7) }))).toBe(45);
    expect(churnRiskScore(input({ autoRenewOff: true, lastSeenAt: days(14) }))).toBe(55);
    expect(churnRiskScore(input({ autoRenewOff: true, lastSeenAt: days(30) }))).toBe(65);
  });

  it("clamps to 100", () => {
    const old = new Date(NOW.getTime() - 365 * 86_400_000);
    expect(churnRiskScore(input({ hasActiveAccess: false, lastSeenAt: old }))).toBeLessThanOrEqual(100);
  });
});
