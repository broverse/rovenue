import { isIP } from "node:net";
import { Agent, buildConnector } from "undici";

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
