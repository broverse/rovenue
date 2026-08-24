import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, buildConnector, request as undiciRequest } from "undici";
import { env } from "./env";
import type { HttpClient } from "../services/integrations/types";

// =============================================================
// SSRF guard
// =============================================================
//
// Server-side outbound calls whose destination is influenced by
// user/dashboard input (outgoing webhooks, copilot BYOK baseUrl)
// must not be able to reach internal services or the cloud metadata
// endpoint. This module blocks that at CONNECT time: the custom
// undici connector inspects the socket's real `remoteAddress` after
// the TCP handshake and destroys the connection if it lands on a
// non-public range. Validating the connected address (not a
// pre-resolved one) is what closes DNS-rebinding — a hostname that
// resolves public on the first lookup and private on the connect
// still gets caught, and every redirect hop is re-validated because
// fetch reuses this dispatcher.

/**
 * True when `ip` (v4 or v6 literal) is loopback, private, link-local
 * (incl. the 169.254.169.254 cloud-metadata address), unique-local,
 * CGNAT, or otherwise not a publicly routable unicast address.
 */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  // Not a bare IP literal — caller resolves DNS; unknown ⇒ block.
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (IETF/TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.*
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split("%")[0]!; // strip zone id
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified

  // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::a.b.c.d) — validate the
  // embedded v4 so an attacker can't smuggle 127.0.0.1 through v6.
  const mapped = lower.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);

  const head = lower.split(":")[0] ?? "";
  const first16 = head === "" ? 0 : parseInt(head.padEnd(4, "0").slice(0, 4), 16);
  if ((first16 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first16 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (lower.startsWith("64:ff9b:")) return true; // NAT64 (embeds v4)
  return false;
}

const baseConnector = buildConnector({ timeout: 10_000 });

/**
 * Shared undici dispatcher that refuses to complete a connection to a
 * non-public address. Pass it as `dispatcher` to `fetch`, or via the
 * AI-SDK `fetch` option, for any request whose URL is user-controlled.
 */
export const ssrfSafeAgent = new Agent({
  connect(opts, callback) {
    baseConnector(opts, (err, socket) => {
      if (err || !socket) {
        callback(err ?? new Error("connect failed"), null);
        return;
      }
      const addr = socket.remoteAddress;
      if (!addr || isBlockedIp(addr)) {
        socket.destroy();
        callback(
          new Error(
            `SSRF blocked: ${String(opts.hostname)} resolved to non-public address ${addr ?? "unknown"}`,
          ),
          null,
        );
        return;
      }
      callback(null, socket);
    });
  },
});

/**
 * Cheap up-front check for save-time validation paths (e.g. persisting a
 * webhook or BYOK baseUrl). Rejects non-http(s) schemes and IP-literal
 * hosts that are already known-bad, so an obviously-internal URL fails
 * with a clear 4xx before we ever store it. Runtime enforcement still
 * relies on {@link ssrfSafeAgent} at connect time (DNS names, rebinding).
 */
export function assertAllowedOutboundUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // unwrap [::1]
  if (host.toLowerCase() === "localhost") {
    throw new Error("URL host is not allowed");
  }
  if (isIP(host) && isBlockedIp(host)) {
    throw new Error("URL host resolves to a non-public address");
  }
  return url;
}

/**
 * Drop-in `fetch` that routes through {@link ssrfSafeAgent}. Suitable as
 * the AI-SDK provider `fetch` option or anywhere a guarded fetch is needed.
 */
export const ssrfSafeFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, dispatcher: ssrfSafeAgent } as RequestInit);

// =============================================================
// CUSTOM_WEBHOOK-specific SSRF guard (Task 7)
// =============================================================
//
// The generic guard above validates at TCP-connect time via a custom
// connector — good for a single guarded fetch/Agent, but it doesn't hand
// back the resolved address for reuse. CUSTOM_WEBHOOK delivery needs the
// resolved IP up front so it can be pinned into the actual request (the
// same address that was validated is the one connected to — no second,
// unpinned DNS lookup in between) and so the delivery classification code
// can distinguish "URL rejected before any network call" from HTTP/network
// outcomes. Two layers:
//
//  1. assertPublicWebhookUrl — sync, cheap checks on the URL itself
//     (scheme, userinfo, IP-literal host against BLOCKED_CIDRS).
//  2. resolvePinnedAddress — resolves the hostname via DNS and rejects
//     the whole result set if ANY resolved address is private (defends
//     against DNS-rebinding: a hostname that resolves to a public IP at
//     validation time and a private one at connect time). The single
//     address it returns is later pinned into the actual TCP connection
//     by createPinnedHttpClient so the DNS answer used for validation is
//     the same one used for the request.
//
// Both checks are gated by ALLOW_PRIVATE_TARGETS, derived from
// NODE_ENV !== "production": self-hosted local dev and CI regularly point
// CUSTOM_WEBHOOK at http://localhost:… or a container-network IP, so the
// private-target block only applies in production. Tests inject the mode
// explicitly via `deps.allowPrivateTargets` rather than mutating
// `process.env.NODE_ENV` (see the vitest env/import-hoisting footgun —
// lib/env.ts parses NODE_ENV once at import time, so a later assignment in
// a test file is silently a no-op and would leak between tests anyway).

export class WebhookUrlError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "WebhookUrlError";
  }
}

/** Non-production allows http:// and private/loopback targets (dev/test story). */
export const ALLOW_PRIVATE_TARGETS = env.NODE_ENV !== "production";

interface BlockedCidr {
  family: "ipv4" | "ipv6";
  address: string;
  prefix: number;
  /** Human label for error messages. */
  label: string;
}

/** Named table of blocked ranges — never inline literals at the check sites. */
export const BLOCKED_CIDRS: readonly BlockedCidr[] = [
  { family: "ipv4", address: "127.0.0.0", prefix: 8, label: "127.0.0.0/8 (loopback)" },
  { family: "ipv4", address: "10.0.0.0", prefix: 8, label: "10.0.0.0/8 (private)" },
  { family: "ipv4", address: "172.16.0.0", prefix: 12, label: "172.16.0.0/12 (private)" },
  { family: "ipv4", address: "192.168.0.0", prefix: 16, label: "192.168.0.0/16 (private)" },
  { family: "ipv4", address: "169.254.0.0", prefix: 16, label: "169.254.0.0/16 (link-local / cloud metadata)" },
  { family: "ipv4", address: "0.0.0.0", prefix: 8, label: "0.0.0.0/8 (this network)" },
  { family: "ipv6", address: "::1", prefix: 128, label: "::1/128 (loopback)" },
  { family: "ipv6", address: "fc00::", prefix: 7, label: "fc00::/7 (unique local)" },
  { family: "ipv6", address: "fe80::", prefix: 10, label: "fe80::/10 (link-local)" },
];

let blockList: BlockList | undefined;

function getBlockList(): BlockList {
  if (!blockList) {
    blockList = new BlockList();
    for (const cidr of BLOCKED_CIDRS) {
      blockList.addSubnet(cidr.address, cidr.prefix, cidr.family);
    }
  }
  return blockList;
}

/** True for any IP address (v4 or v6) that falls inside BLOCKED_CIDRS, or
 *  that fails to parse as a valid IP at all (fail closed). */
function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return getBlockList().check(ip, "ipv4");
  if (family === 6) return getBlockList().check(ip, "ipv6");
  return true;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Sync validation of a candidate webhook URL: scheme, userinfo, and (unless
 * `deps.allowPrivateTargets`) IP-literal / localhost host checks. Does NOT
 * perform DNS resolution — see resolvePinnedAddress for that.
 */
export function assertPublicWebhookUrl(
  raw: string,
  deps: { allowPrivateTargets?: boolean } = {},
): URL {
  const allowPrivateTargets = deps.allowPrivateTargets ?? ALLOW_PRIVATE_TARGETS;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError("malformed webhook URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebhookUrlError(`unsupported URL scheme: ${url.protocol}`);
  }
  if (url.protocol === "http:" && !allowPrivateTargets) {
    throw new WebhookUrlError("http:// is not allowed in production; use https://");
  }
  if (url.username || url.password) {
    throw new WebhookUrlError("credentials in the webhook URL are not allowed");
  }

  if (!allowPrivateTargets) {
    const bareHost = stripBrackets(url.hostname.toLowerCase());
    if (bareHost === "localhost") {
      throw new WebhookUrlError("localhost is not a publicly routable webhook target");
    }
    if (isIP(bareHost) && isBlockedAddress(bareHost)) {
      throw new WebhookUrlError(`IP-literal webhook target is not publicly routable: ${bareHost}`);
    }
  }

  return url;
}

export type AddressLookup = (hostname: string) => Promise<string[]>;

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * Resolves `url`'s hostname to a single pinned IP address. Rejects the
 * whole DNS answer if any resolved address is private/blocked (unless
 * `deps.allowPrivateTargets`) — a single public-looking address alongside a
 * private one is exactly the DNS-rebinding shape, so any private address
 * poisons the set rather than being filtered out.
 */
export async function resolvePinnedAddress(
  url: URL,
  deps: { lookup?: AddressLookup; allowPrivateTargets?: boolean } = {},
): Promise<string> {
  const allowPrivateTargets = deps.allowPrivateTargets ?? ALLOW_PRIVATE_TARGETS;
  const bareHost = stripBrackets(url.hostname);

  // Already an IP literal — nothing to resolve, and assertPublicWebhookUrl
  // already validated it against BLOCKED_CIDRS for this same mode.
  if (isIP(bareHost)) {
    if (!allowPrivateTargets && isBlockedAddress(bareHost)) {
      throw new WebhookUrlError(`IP-literal webhook target is not publicly routable: ${bareHost}`);
    }
    return bareHost;
  }

  const lookup = deps.lookup ?? defaultLookup;
  const addresses = await lookup(url.hostname);
  if (addresses.length === 0) {
    throw new WebhookUrlError(`DNS resolution returned no addresses for ${url.hostname}`);
  }

  if (!allowPrivateTargets) {
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        throw new WebhookUrlError(
          `resolved address is not publicly routable: ${address}`,
        );
      }
    }
  }

  return addresses[0]!;
}

/** Deadline for the whole delivery attempt: connection + headers + body. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 15_000;

/**
 * Builds an HttpClient whose underlying undici Agent connects ONLY to
 * `pinnedIp`, no matter what hostname the request URL carries — this is
 * what makes resolvePinnedAddress's DNS answer authoritative: the TCP
 * connection uses the exact address that was validated, so a subsequent,
 * unpinned DNS lookup at connect time (which could return a different,
 * private address — DNS rebinding) never happens. TLS SNI and the Host
 * header still use the original hostname because the request URL itself is
 * unchanged; only the low-level `net`/`tls` connect target is overridden.
 * Redirects are never followed (`maxRedirections: 0`) — a 3xx response is
 * classified by the caller instead of being transparently chased, which
 * could otherwise re-route the request outside the pinned/validated host.
 */
export function createPinnedHttpClient(pinnedIp: string): HttpClient {
  const pinnedFamily = isIP(pinnedIp);

  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    const wantsAll = typeof options === "object" && options !== null && "all" in options && options.all;
    if (wantsAll) {
      callback(null, [{ address: pinnedIp, family: pinnedFamily }]);
    } else {
      callback(null, pinnedIp, pinnedFamily);
    }
  };

  const agent = new Agent({
    connect: { lookup: pinnedLookup },
    maxRedirections: 0,
    headersTimeout: WEBHOOK_DELIVERY_TIMEOUT_MS,
    bodyTimeout: WEBHOOK_DELIVERY_TIMEOUT_MS,
  });

  return {
    async request(input) {
      const res = await undiciRequest(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        dispatcher: agent,
      });
      const text = await res.body.text();
      return { status: res.statusCode, body: text };
    },
  };
}
