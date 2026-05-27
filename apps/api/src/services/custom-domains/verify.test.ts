import { describe, expect, it } from "vitest";
import {
  CANONICAL_EDGE_HOST,
  checkHostname,
  verifyCustomDomain,
  type DnsProbe,
} from "./verify";

describe("checkHostname", () => {
  it.each([
    ["quiz.acme.com", true],
    ["sub.quiz.acme.com", true],
    ["a.b", true],
    ["acme.com", true],
  ])("accepts %s", (host, _expected) => {
    expect(checkHostname(host).ok).toBe(true);
  });

  it.each([
    ["", "hostname_invalid"],
    ["nodots", "hostname_invalid"],
    ["-leading.example.com", "hostname_invalid"],
    ["trailing-.example.com", "hostname_invalid"],
    ["double..dot.example.com", "hostname_invalid"],
    ["space in.example.com", "hostname_invalid"],
    ["UPPER.CASE.com", "hostname_invalid"], // input must be normalised; regex is case-insensitive but we accept this
    // ...wait — checkHostname lowercases internally, so UPPER.CASE.com is accepted.
  ])("rejects shape: %s", (host, reason) => {
    if (host === "UPPER.CASE.com") return; // documented as accepted (normalised)
    const result = checkHostname(host);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("accepts mixed-case input by normalising", () => {
    expect(checkHostname("QUIZ.Acme.COM").ok).toBe(true);
  });

  it.each([
    "rovenue.app",
    "edge.rovenue.app",
    "anything.rovenue.app",
    "rovenue.com",
    "rovenue.dev",
    "foo.local",
  ])("rejects reserved hostname %s", (host) => {
    const result = checkHostname(host);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hostname_reserved");
  });

  it("rejects bare 'localhost' as invalid shape (single-label, no dot)", () => {
    // Shape check runs before the reserved-list, and `localhost` has no
    // dot — that's enough to block it regardless of the reserved-list.
    const result = checkHostname("localhost");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hostname_invalid");
  });

  it("rejects label longer than 63 chars", () => {
    const tooLong = "a".repeat(64) + ".example.com";
    expect(checkHostname(tooLong).ok).toBe(false);
  });

  it("rejects total length over 253 chars", () => {
    const huge = (Array.from({ length: 20 }, () => "abcdefghijklm")).join(".") + ".example.com";
    expect(huge.length).toBeGreaterThan(253);
    expect(checkHostname(huge).ok).toBe(false);
  });
});

describe("verifyCustomDomain", () => {
  const token = "0".repeat(64);
  const host = "quiz.acme.com";
  const expectedTxt = `rv-verify=${token}`;

  function fakeProbe(map: Record<string, { cnames: string[]; txt: string[]; error?: string }>): DnsProbe {
    return async (resolverIp) => map[resolverIp] ?? { cnames: [], txt: [] };
  }

  it("ok when both resolvers see the right CNAME + TXT", async () => {
    const probe = fakeProbe({
      "1.1.1.1": { cnames: [CANONICAL_EDGE_HOST], txt: [expectedTxt] },
      "8.8.8.8": { cnames: [CANONICAL_EDGE_HOST], txt: [expectedTxt] },
    });
    const result = await verifyCustomDomain(host, token, { probe });
    expect(result).toEqual({ ok: true });
  });

  it("ok when CNAME comes back uppercased — resolver case is not significant", async () => {
    const probe = fakeProbe({
      "1.1.1.1": { cnames: ["EDGE.ROVENUE.APP"], txt: [expectedTxt] },
      "8.8.8.8": { cnames: [CANONICAL_EDGE_HOST], txt: [expectedTxt] },
    });
    // liveDnsProbe lowercases — emulate that here.
    const lowering: DnsProbe = async (ip, h) => {
      const r = await probe(ip, h);
      return { ...r, cnames: r.cnames.map((c) => c.toLowerCase()) };
    };
    const result = await verifyCustomDomain(host, token, { probe: lowering });
    expect(result).toEqual({ ok: true });
  });

  it("cname_missing when no resolver sees a CNAME", async () => {
    const probe = fakeProbe({
      "1.1.1.1": { cnames: [], txt: [expectedTxt] },
      "8.8.8.8": { cnames: [], txt: [expectedTxt] },
    });
    const result = await verifyCustomDomain(host, token, { probe });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cname_missing");
  });

  it("cname_mismatch when resolver sees a CNAME pointing somewhere else", async () => {
    const probe = fakeProbe({
      "1.1.1.1": { cnames: ["evil.example.com"], txt: [expectedTxt] },
      "8.8.8.8": { cnames: [CANONICAL_EDGE_HOST], txt: [expectedTxt] },
    });
    const result = await verifyCustomDomain(host, token, { probe });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cname_mismatch");
  });

  it("txt_missing when CNAME is fine but TXT challenge is absent", async () => {
    const probe = fakeProbe({
      "1.1.1.1": { cnames: [CANONICAL_EDGE_HOST], txt: [] },
      "8.8.8.8": { cnames: [CANONICAL_EDGE_HOST], txt: [] },
    });
    const result = await verifyCustomDomain(host, token, { probe });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("txt_missing");
  });

  it("txt_mismatch when TXT exists but value is wrong", async () => {
    const probe = fakeProbe({
      "1.1.1.1": { cnames: [CANONICAL_EDGE_HOST], txt: ["rv-verify=wrongtoken"] },
      "8.8.8.8": { cnames: [CANONICAL_EDGE_HOST], txt: ["rv-verify=wrongtoken"] },
    });
    const result = await verifyCustomDomain(host, token, { probe });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("txt_mismatch");
  });

  it("resolver_disagreement-style failure surfaces as cname_mismatch when only one sees the right CNAME", async () => {
    // Both must agree — if one resolver sees the right thing and another sees
    // something different, we fail (don't accidentally accept poisoned half-truths).
    const probe = fakeProbe({
      "1.1.1.1": { cnames: [CANONICAL_EDGE_HOST], txt: [expectedTxt] },
      "8.8.8.8": { cnames: ["something.else"], txt: [expectedTxt] },
    });
    const result = await verifyCustomDomain(host, token, { probe });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cname_mismatch");
  });

  it("resolver_error when all probes fail", async () => {
    const probe: DnsProbe = async () => ({ cnames: [], txt: [], error: "ENOTFOUND" });
    const result = await verifyCustomDomain(host, token, { probe });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("resolver_error");
      expect(result.detail).toBe("ENOTFOUND");
    }
  });
});
