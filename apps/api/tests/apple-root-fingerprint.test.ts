import { describe, expect, test, vi } from "vitest";
import {
  APPLE_ROOT_FINGERPRINTS,
  assertAppleRootFingerprints,
  fingerprintOf,
} from "../src/services/apple/apple-root-fingerprints";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(__dirname, "_helpers/apple-roots");

describe("Apple root fingerprint verification", () => {
  test("rejects a buffer that does not match any pinned fingerprint", () => {
    const bogus = Buffer.from("not-a-real-cert");
    expect(() => assertAppleRootFingerprints([bogus])).toThrow(
      /fingerprint/i,
    );
  });

  test.skipIf(!existsSync(FIXTURE_DIR) || !statSync(FIXTURE_DIR).isDirectory())(
    "accepts when every provided buffer matches a pinned fingerprint",
    () => {
      const files = readdirSync(FIXTURE_DIR)
        .filter((f) => !f.startsWith("."))
        .map((f) => readFileSync(join(FIXTURE_DIR, f)));
      if (files.length === 0) {
        throw new Error(
          "apple-roots fixture dir exists but is empty — drop .cer files",
        );
      }
      expect(() => assertAppleRootFingerprints(files)).not.toThrow();
    },
  );

  test("fingerprintOf produces a hex SHA-256 digest", () => {
    const buf = Buffer.from("hello");
    expect(fingerprintOf(buf)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("APPLE_ROOT_FINGERPRINTS set contains pinned G3 + AAI hashes", () => {
    expect(APPLE_ROOT_FINGERPRINTS.size).toBeGreaterThanOrEqual(1);
    for (const fp of APPLE_ROOT_FINGERPRINTS) {
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("APPLE_ROOT_FINGERPRINTS is immutable at runtime", () => {
    expect(() =>
      (APPLE_ROOT_FINGERPRINTS as Set<string>).add("ffffffff"),
    ).toThrow(/immutable/i);
  });

  test("loadAppleRootCerts fails closed when APPLE_ROOT_CERTS_DIR holds a bogus cert", async () => {
    const tmp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await tmp.mkdtemp(path.join(os.tmpdir(), "apple-roots-"));
    await tmp.writeFile(path.join(dir, "bad.cer"), "not-a-cert");

    const prevEnv = process.env.APPLE_ROOT_CERTS_DIR;
    process.env.APPLE_ROOT_CERTS_DIR = dir;
    try {
      vi.resetModules();
      const { loadAppleRootCerts } = await import(
        "../src/services/apple/apple-root-ca"
      );
      expect(() => loadAppleRootCerts()).toThrow(/fingerprint/i);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.APPLE_ROOT_CERTS_DIR;
      } else {
        process.env.APPLE_ROOT_CERTS_DIR = prevEnv;
      }
      vi.resetModules();
    }
  });

  test("loadAppleRootCerts re-throws the fingerprint error on subsequent calls", async () => {
    const tmp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await tmp.mkdtemp(path.join(os.tmpdir(), "apple-roots-"));
    await tmp.writeFile(path.join(dir, "bad.cer"), "not-a-cert");

    const prevEnv = process.env.APPLE_ROOT_CERTS_DIR;
    process.env.APPLE_ROOT_CERTS_DIR = dir;
    try {
      vi.resetModules();
      const { loadAppleRootCerts } = await import(
        "../src/services/apple/apple-root-ca"
      );

      expect(() => loadAppleRootCerts()).toThrow(/fingerprint/i);
      // Second call must also throw — never silently return null.
      expect(() => loadAppleRootCerts()).toThrow(/fingerprint/i);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.APPLE_ROOT_CERTS_DIR;
      } else {
        process.env.APPLE_ROOT_CERTS_DIR = prevEnv;
      }
      vi.resetModules();
    }
  });
});
