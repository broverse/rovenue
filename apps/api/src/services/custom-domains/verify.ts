import { Resolver } from "node:dns/promises";

// Hostnames matching these patterns can never be claimed as custom domains.
// Keep this list narrow — we only block what would actively conflict with
// our own surface or break sanity (local-only addresses).
const RESERVED_HOSTNAMES = [
  /^rovenue\.(app|com|dev)$/i,
  /^[^.]+\.rovenue\.(app|com|dev)$/i,
  /^localhost$/i,
  /^[^.]+\.local$/i,
  /^[^.]+\.localhost$/i,
];

// RFC 1123 hostname: labels of 1–63 chars, total ≤ 253, no leading/trailing
// hyphen per label, no consecutive dots. We additionally require ≥ 1 dot so
// a single-label hostname like "intranet" never reaches the verifier.
const HOSTNAME_REGEX =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// Pinned to the project edge. Used both as the CNAME target and as the
// resolver target in the public verification UI.
export const CANONICAL_EDGE_HOST = "edge.rovenue.app";

export type VerifyFailureReason =
  | "cname_missing"
  | "cname_mismatch"
  | "txt_missing"
  | "txt_mismatch"
  | "resolver_error"
  | "resolver_disagreement";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason; detail?: string };

export type HostnameRejection =
  | { ok: true }
  | { ok: false; reason: "hostname_invalid" | "hostname_reserved" };

/**
 * Validate a hostname against our shape + reserved list. Caller is expected
 * to lowercase the input before persisting — this checker does NOT mutate.
 */
export function checkHostname(raw: string): HostnameRejection {
  const host = raw.trim().toLowerCase();
  if (!HOSTNAME_REGEX.test(host)) return { ok: false, reason: "hostname_invalid" };
  if (RESERVED_HOSTNAMES.some((re) => re.test(host))) {
    return { ok: false, reason: "hostname_reserved" };
  }
  return { ok: true };
}

/**
 * Verify a hostname's CNAME + TXT challenge against two independent
 * recursive resolvers. Both must agree to defend against transient
 * single-resolver glitches and DNS-poisoning surprises.
 */
export async function verifyCustomDomain(
  hostname: string,
  verificationToken: string,
  opts: { resolvers?: ReadonlyArray<readonly [string, string]> } = {},
): Promise<VerifyResult> {
  // Defaults intentionally hard-coded to Cloudflare (1.1.1.1) and Google
  // (8.8.8.8) — two unrelated networks, low latency, no logging.
  const resolverPairs =
    opts.resolvers ??
    ([
      ["cloudflare", "1.1.1.1"],
      ["google", "8.8.8.8"],
    ] as const);

  const txtName = `_rovenue.${hostname}`;
  const expectedTxt = `rv-verify=${verificationToken}`;

  type Probe = {
    name: string;
    cnames: string[];
    txt: string[];
    error?: string;
  };

  const probes: Probe[] = await Promise.all(
    resolverPairs.map(async ([name, ip]): Promise<Probe> => {
      const resolver = new Resolver();
      resolver.setServers([ip]);
      try {
        const [cnameResult, txtResult] = await Promise.allSettled([
          resolver.resolveCname(hostname),
          resolver.resolveTxt(txtName),
        ]);
        const cnames =
          cnameResult.status === "fulfilled" ? cnameResult.value.map((c) => c.toLowerCase()) : [];
        // TXT comes back as string[][]; flatten and join each chunk-set into
        // one record value (DNS chunks long records into <256-byte pieces).
        const txt =
          txtResult.status === "fulfilled" ? txtResult.value.map((chunks) => chunks.join("")) : [];
        return { name, cnames, txt };
      } catch (err) {
        return { name, cnames: [], txt: [], error: (err as Error).message };
      }
    }),
  );

  const allErrored = probes.every((p) => p.error);
  if (allErrored) {
    return { ok: false, reason: "resolver_error", detail: probes[0]?.error };
  }

  const cnameOk = probes.every((p) => p.cnames.includes(CANONICAL_EDGE_HOST));
  if (!cnameOk) {
    const anyHasCname = probes.some((p) => p.cnames.length > 0);
    return {
      ok: false,
      reason: anyHasCname ? "cname_mismatch" : "cname_missing",
      detail: probes.map((p) => `${p.name}=${p.cnames.join("|") || "∅"}`).join(", "),
    };
  }

  const txtOk = probes.every((p) => p.txt.includes(expectedTxt));
  if (!txtOk) {
    const anyHasTxt = probes.some((p) => p.txt.length > 0);
    return {
      ok: false,
      reason: anyHasTxt ? "txt_mismatch" : "txt_missing",
      detail: probes.map((p) => `${p.name}=${p.txt.join("|") || "∅"}`).join(", "),
    };
  }

  return { ok: true };
}
