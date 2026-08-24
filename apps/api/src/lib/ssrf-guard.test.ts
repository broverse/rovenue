import { describe, expect, it, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  WebhookUrlError,
  BLOCKED_CIDRS,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  assertPublicWebhookUrl,
  assertAllowedOutboundUrl,
  resolvePinnedAddress,
  createPinnedHttpClient,
} from "./ssrf-guard";

// ---------------------------------------------------------------------------
// assertAllowedOutboundUrl — the pre-existing, always-strict guard (copilot
// BYOK baseUrl). Locked in here because assertPublicWebhookUrl's host/
// IP-literal check was refactored to share isBlockedHost with this
// function; these tests pin its own behavior unchanged by that refactor.
// ---------------------------------------------------------------------------

describe("assertAllowedOutboundUrl", () => {
  it("accepts a public https URL", () => {
    const url = assertAllowedOutboundUrl("https://example.com/hook");
    expect(url.hostname).toBe("example.com");
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => assertAllowedOutboundUrl("ftp://example.com/hook")).toThrow();
  });

  it("rejects localhost", () => {
    expect(() => assertAllowedOutboundUrl("https://localhost/hook")).toThrow();
  });

  it("rejects a private IPv4 literal", () => {
    expect(() => assertAllowedOutboundUrl("https://10.0.0.5/hook")).toThrow();
  });

  it("rejects a CGNAT IPv4 literal", () => {
    expect(() => assertAllowedOutboundUrl("https://100.64.0.1/hook")).toThrow();
  });

  it("rejects the unspecified IPv6 literal [::]", () => {
    expect(() => assertAllowedOutboundUrl("https://[::]/hook")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertPublicWebhookUrl
// ---------------------------------------------------------------------------

describe("assertPublicWebhookUrl", () => {
  it("accepts a plain public https URL", () => {
    const url = assertPublicWebhookUrl("https://example.com/hook");
    expect(url.hostname).toBe("example.com");
  });

  it("rejects http:// in production mode", () => {
    expect(() =>
      assertPublicWebhookUrl("http://example.com/hook", {
        allowPrivateTargets: false,
      }),
    ).toThrow(WebhookUrlError);
  });

  it("accepts http:// outside production (dev/test story)", () => {
    expect(() =>
      assertPublicWebhookUrl("http://example.com/hook", {
        allowPrivateTargets: true,
      }),
    ).not.toThrow();
  });

  it("rejects non-http(s) schemes regardless of mode", () => {
    expect(() =>
      assertPublicWebhookUrl("ftp://example.com/hook", {
        allowPrivateTargets: true,
      }),
    ).toThrow(WebhookUrlError);
    expect(() =>
      assertPublicWebhookUrl("ftp://example.com/hook", {
        allowPrivateTargets: false,
      }),
    ).toThrow(WebhookUrlError);
  });

  it("rejects credentials in the URL regardless of mode", () => {
    expect(() =>
      assertPublicWebhookUrl("https://u:p@host.example/hook", {
        allowPrivateTargets: true,
      }),
    ).toThrow(WebhookUrlError);
    expect(() =>
      assertPublicWebhookUrl("https://u:p@host.example/hook", {
        allowPrivateTargets: false,
      }),
    ).toThrow(WebhookUrlError);
  });

  it("rejects localhost in production mode", () => {
    expect(() =>
      assertPublicWebhookUrl("https://localhost/hook", {
        allowPrivateTargets: false,
      }),
    ).toThrow(WebhookUrlError);
  });

  it("accepts localhost outside production", () => {
    expect(() =>
      assertPublicWebhookUrl("https://localhost/hook", {
        allowPrivateTargets: true,
      }),
    ).not.toThrow();
  });

  const blockedIpLiterals = [
    "127.0.0.1", // 127.0.0.0/8
    "10.1.2.3", // 10.0.0.0/8
    "172.16.5.9", // 172.16.0.0/12
    "192.168.1.1", // 192.168.0.0/16
    "169.254.169.254", // 169.254.0.0/16 (cloud metadata)
    "0.0.0.0", // 0.0.0.0/8
    "100.64.0.1", // 100.64.0.0/10 (CGNAT) — NOT in BLOCKED_CIDRS, only in
    // isBlockedIp; proves isBlockedAddress is the union of both tables,
    // not BLOCKED_CIDRS alone.
  ];

  for (const ip of blockedIpLiterals) {
    it(`rejects IPv4-literal ${ip} in production mode`, () => {
      expect(() =>
        assertPublicWebhookUrl(`https://${ip}/hook`, {
          allowPrivateTargets: false,
        }),
      ).toThrow(WebhookUrlError);
    });

    it(`accepts IPv4-literal ${ip} outside production`, () => {
      expect(() =>
        assertPublicWebhookUrl(`https://${ip}/hook`, {
          allowPrivateTargets: true,
        }),
      ).not.toThrow();
    });
  }

  const blockedIpv6Literals = [
    "::1",
    "fc00::1",
    "fe80::1",
    "::", // unspecified address — NOT in BLOCKED_CIDRS (only ::1/128 is
    // there); a hostname of "[::]" pins to loopback on Linux, so this must
    // be blocked too. Proves isBlockedAddress is the union, not
    // BLOCKED_CIDRS alone.
    "64:ff9b::1", // NAT64 (embeds a v4 address) — also not in BLOCKED_CIDRS.
  ];

  for (const ip of blockedIpv6Literals) {
    it(`rejects IPv6-literal ${ip} in production mode`, () => {
      expect(() =>
        assertPublicWebhookUrl(`https://[${ip}]/hook`, {
          allowPrivateTargets: false,
        }),
      ).toThrow(WebhookUrlError);
    });

    it(`accepts IPv6-literal ${ip} outside production`, () => {
      expect(() =>
        assertPublicWebhookUrl(`https://[${ip}]/hook`, {
          allowPrivateTargets: true,
        }),
      ).not.toThrow();
    });
  }

  it("accepts a public IP literal in production mode", () => {
    expect(() =>
      assertPublicWebhookUrl("https://203.0.113.7/hook", {
        allowPrivateTargets: false,
      }),
    ).not.toThrow();
  });

  it("BLOCKED_CIDRS is a named const table, not inline literals", () => {
    expect(Array.isArray(BLOCKED_CIDRS)).toBe(true);
    expect(BLOCKED_CIDRS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolvePinnedAddress
// ---------------------------------------------------------------------------

describe("resolvePinnedAddress", () => {
  it("rejects when ANY resolved address is private (DNS-rebinding defence)", async () => {
    const url = new URL("https://rebind.example/hook");
    await expect(
      resolvePinnedAddress(url, {
        allowPrivateTargets: false,
        lookup: async () => ["203.0.113.7", "10.0.0.5"],
      }),
    ).rejects.toThrow(WebhookUrlError);
  });

  it("resolves to the first address when all resolved addresses are public", async () => {
    const url = new URL("https://all-public.example/hook");
    const pinned = await resolvePinnedAddress(url, {
      allowPrivateTargets: false,
      lookup: async () => ["203.0.113.7", "203.0.113.8"],
    });
    expect(pinned).toBe("203.0.113.7");
  });

  it("allows a private resolved address outside production", async () => {
    const url = new URL("https://internal.example/hook");
    const pinned = await resolvePinnedAddress(url, {
      allowPrivateTargets: true,
      lookup: async () => ["10.0.0.5"],
    });
    expect(pinned).toBe("10.0.0.5");
  });

  it("throws when DNS resolution returns no addresses", async () => {
    const url = new URL("https://nowhere.example/hook");
    await expect(
      resolvePinnedAddress(url, {
        allowPrivateTargets: false,
        lookup: async () => [],
      }),
    ).rejects.toThrow(WebhookUrlError);
  });

  it("short-circuits DNS for an already-literal public IP host", async () => {
    const url = new URL("https://203.0.113.9/hook");
    const pinned = await resolvePinnedAddress(url, {
      allowPrivateTargets: false,
      lookup: async () => {
        throw new Error("lookup should not be called for an IP-literal host");
      },
    });
    expect(pinned).toBe("203.0.113.9");
  });

  it("rejects a resolved CGNAT address (100.64.0.0/10 — not in BLOCKED_CIDRS, covered via isBlockedIp union)", async () => {
    const url = new URL("https://cgnat.example/hook");
    await expect(
      resolvePinnedAddress(url, {
        allowPrivateTargets: false,
        lookup: async () => ["100.64.0.1"],
      }),
    ).rejects.toThrow(WebhookUrlError);
  });

  it("rejects a resolved unspecified IPv6 address (:: — not in BLOCKED_CIDRS)", async () => {
    const url = new URL("https://unspecified.example/hook");
    await expect(
      resolvePinnedAddress(url, {
        allowPrivateTargets: false,
        lookup: async () => ["::"],
      }),
    ).rejects.toThrow(WebhookUrlError);
  });

  it("rejects a resolved NAT64 address (64:ff9b::/96 — not in BLOCKED_CIDRS)", async () => {
    const url = new URL("https://nat64.example/hook");
    await expect(
      resolvePinnedAddress(url, {
        allowPrivateTargets: false,
        lookup: async () => ["64:ff9b::1"],
      }),
    ).rejects.toThrow(WebhookUrlError);
  });
});

// ---------------------------------------------------------------------------
// createPinnedHttpClient
// ---------------------------------------------------------------------------

describe("createPinnedHttpClient", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("connects to the pinned IP regardless of the request URL's hostname", async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned-ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const client = createPinnedHttpClient("127.0.0.1");
    // Use a hostname that cannot resolve via real DNS — proves the request
    // actually went to the pinned IP via the custom `lookup`, not real DNS.
    const res = await client.request({
      method: "GET",
      url: `http://definitely-not-a-real-host.invalid:${port}/hook`,
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe("pinned-ok");
  });

  it("does not follow redirects (maxRedirections: 0)", async () => {
    server = createServer((req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1/elsewhere" });
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const client = createPinnedHttpClient("127.0.0.1");
    const res = await client.request({
      method: "GET",
      url: `http://redirect-target.invalid:${port}/hook`,
    });

    expect(res.status).toBe(302);
  });

  it("WEBHOOK_DELIVERY_TIMEOUT_MS is a named positive constant", () => {
    expect(typeof WEBHOOK_DELIVERY_TIMEOUT_MS).toBe("number");
    expect(WEBHOOK_DELIVERY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
