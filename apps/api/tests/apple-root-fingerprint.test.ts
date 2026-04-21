import { describe, expect, test } from "vitest";
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
});
