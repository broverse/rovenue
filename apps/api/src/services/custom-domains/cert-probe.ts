import { connect, type TLSSocket } from "node:tls";

// =============================================================
// TLS handshake probe for custom-domain cert issuance
// =============================================================
//
// Caddy's on-demand TLS issues a cert the first time a real client
// (or our probe) handshakes to a verified hostname. Rather than
// poll Caddy's admin API for cert state — which would tightly
// couple us to Caddy internals — we just do what a browser does:
// open a TLS connection on :443, ask for the cert chain, and check
// whether it's valid for this hostname and not expired.
//
// Outcomes:
//   - 'issued'  — handshake succeeded, cert covers the hostname,
//                 not expired.
//   - 'issuing' — handshake failed in a way that suggests "cert not
//                 ready yet" (timeout, ECONNREFUSED, ERR_SSL_*). We
//                 re-probe; Caddy may still be solving the ACME
//                 challenge.
//   - 'failed'  — handshake completed but cert is self-signed,
//                 expired, or covers a different name. These are
//                 permanent failures from the operator's perspective
//                 (CAA misconfig, fresh wildcard takeover, etc).

export type CertProbeResult =
  | { status: "issued"; notAfter: Date }
  | { status: "issuing"; reason: string }
  | { status: "failed"; reason: string };

export type CertProbe = (hostname: string) => Promise<CertProbeResult>;

const PROBE_TIMEOUT_MS = 5000;

/**
 * Real-network probe — opens a TLS connection to `{hostname}:443`
 * with SNI and inspects the served certificate.
 */
export const liveCertProbe: CertProbe = (hostname) =>
  new Promise<CertProbeResult>((resolve) => {
    let resolved = false;
    const done = (r: CertProbeResult) => {
      if (resolved) return;
      resolved = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    const socket: TLSSocket = connect(
      {
        host: hostname,
        port: 443,
        servername: hostname, // SNI — Caddy needs this to pick the right cert
        // We want to inspect even self-signed / mismatched certs so we
        // can return 'failed' with the right reason — node's TLS module
        // surfaces the cert in `socket.getPeerCertificate()` either way.
        rejectUnauthorized: false,
        timeout: PROBE_TIMEOUT_MS,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          if (!cert || Object.keys(cert).length === 0) {
            done({ status: "issuing", reason: "no_cert_returned" });
            return;
          }
          // Caddy serves an internal self-signed for unknown hostnames
          // when on-demand TLS hasn't issued yet. Detect via issuer CN.
          const issuerCnRaw = cert.issuer?.CN ?? "";
          const issuerCn = Array.isArray(issuerCnRaw) ? issuerCnRaw[0] ?? "" : issuerCnRaw;
          if (/caddy local authority/i.test(issuerCn)) {
            done({ status: "issuing", reason: "self_signed_placeholder" });
            return;
          }
          const notAfter = new Date(cert.valid_to);
          if (Number.isNaN(notAfter.getTime())) {
            done({ status: "failed", reason: "invalid_not_after" });
            return;
          }
          if (notAfter.getTime() < Date.now()) {
            done({ status: "failed", reason: "expired" });
            return;
          }
          if (!certCoversHostname(cert, hostname)) {
            done({ status: "failed", reason: "hostname_mismatch" });
            return;
          }
          done({ status: "issued", notAfter });
        } catch (err) {
          done({ status: "issuing", reason: `inspect_threw:${(err as Error).message}` });
        }
      },
    );

    socket.on("error", (err) => {
      // Connection-time errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT,
      // ENOTFOUND while DNS propagates) all mean "not ready yet" rather
      // than "permanently broken."
      done({ status: "issuing", reason: (err as NodeJS.ErrnoException).code ?? err.message });
    });
    socket.on("timeout", () => {
      done({ status: "issuing", reason: "timeout" });
    });
  });

interface PeerCertSubject {
  CN?: string | string[];
}
interface PeerCert {
  subject?: PeerCertSubject;
  subjectaltname?: string;
}

function certCoversHostname(cert: PeerCert, hostname: string): boolean {
  const host = hostname.toLowerCase();
  // CN can rarely be an array (multi-value); treat first as canonical.
  const cnRaw = cert.subject?.CN;
  const cn = Array.isArray(cnRaw) ? cnRaw[0]?.toLowerCase() : cnRaw?.toLowerCase();
  if (cn && matchName(cn, host)) return true;
  const san = cert.subjectaltname ?? "";
  // SANs look like: "DNS:quiz.acme.com, DNS:*.acme.com"
  for (const part of san.split(/,\s*/)) {
    const m = /^DNS:(.+)$/i.exec(part);
    if (m && matchName(m[1].toLowerCase(), host)) return true;
  }
  return false;
}

function matchName(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".acme.com"
    const dotIdx = host.indexOf(".");
    return dotIdx > 0 && host.slice(dotIdx) === suffix;
  }
  return false;
}
