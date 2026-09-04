import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ESM package — no __dirname. apps/api/tests -> repo root is three up.
const HERE = dirname(fileURLToPath(import.meta.url));
const CERTS_DIR = join(HERE, "..", "..", "..", "deploy", "apple-certs");

/**
 * These bytes are vendored rather than downloaded at image-build time, so
 * nothing else checks them. The App Store JWS verifier chain-pins to them
 * and fails closed; a truncated or expired file would surface as every
 * receipt verification failing in production.
 */
const EXPECTED = [
  { file: "AppleRootCA-G3.cer", subjectContains: "Apple Root CA - G3" },
  { file: "AppleIncRootCertificate.cer", subjectContains: "Apple Root CA" },
];

describe("vendored Apple root certificates", () => {
  it.each(EXPECTED)("$file parses as a certificate", ({ file, subjectContains }) => {
    const cert = new X509Certificate(readFileSync(join(CERTS_DIR, file)));
    expect(cert.subject).toContain(subjectContains);
  });

  it.each(EXPECTED)("$file is self-signed (it is a root)", ({ file }) => {
    const cert = new X509Certificate(readFileSync(join(CERTS_DIR, file)));
    expect(cert.issuer).toBe(cert.subject);
  });

  it.each(EXPECTED)("$file is not expired", ({ file }) => {
    const cert = new X509Certificate(readFileSync(join(CERTS_DIR, file)));
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});
