import { generateKey } from "@rovenue/shared";
import { describe, expect, test } from "vitest";
import {
  decryptCredential,
  encryptCredential,
  encryptProjectCredentials,
  isEncryptedCredential,
  withDecryptedProjectCredentials,
} from "./encrypted-field";

const KEY = generateKey();

describe("encryptCredential / decryptCredential", () => {
  test("round-trips a credentials object", () => {
    const creds = { packageName: "com.example", apiKey: "sk_abc" };

    const wrapped = encryptCredential(creds, KEY);
    const unwrapped = decryptCredential<typeof creds>(wrapped, KEY);

    expect(unwrapped).toEqual(creds);
  });

  test("wrapped value is a tagged object Prisma can persist as Json", () => {
    const wrapped = encryptCredential({ x: 1 }, KEY);

    expect(isEncryptedCredential(wrapped)).toBe(true);
    expect(typeof (wrapped as { enc: string }).enc).toBe("string");
  });

  test("decryptCredential returns null for null input", () => {
    expect(decryptCredential(null, KEY)).toBeNull();
    expect(decryptCredential(undefined, KEY)).toBeNull();
  });

  test("decryptCredential passes plaintext objects through unchanged", () => {
    // Plaintext fallback — acceptable until every project is migrated.
    const plain = { packageName: "com.example" };

    expect(decryptCredential(plain, KEY)).toEqual(plain);
  });
});

describe("encryptProjectCredentials", () => {
  test("encrypts apple, google and stripe fields when present", () => {
    const input = {
      name: "My Project",
      appleCredentials: { bundleId: "com.a" },
      googleCredentials: { packageName: "com.g" },
      stripeCredentials: { secretKey: "sk_live" },
    };

    const out = encryptProjectCredentials(input, KEY);

    expect(isEncryptedCredential(out.appleCredentials)).toBe(true);
    expect(isEncryptedCredential(out.googleCredentials)).toBe(true);
    expect(isEncryptedCredential(out.stripeCredentials)).toBe(true);
    expect(out.name).toBe("My Project");
  });

  test("leaves null credential fields alone", () => {
    const out = encryptProjectCredentials(
      { appleCredentials: null, googleCredentials: null },
      KEY,
    );

    expect(out.appleCredentials).toBeNull();
    expect(out.googleCredentials).toBeNull();
  });

  test("ignores undefined credential fields", () => {
    const out = encryptProjectCredentials({ name: "No creds" }, KEY);

    expect(out).toEqual({ name: "No creds" });
    expect(out).not.toHaveProperty("appleCredentials");
  });
});

describe("withDecryptedProjectCredentials", () => {
  test("decrypts encrypted fields on a project row", () => {
    const apple = { bundleId: "com.a" };
    const google = { packageName: "com.g" };

    const row = {
      id: "p1",
      appleCredentials: encryptCredential(apple, KEY),
      googleCredentials: encryptCredential(google, KEY),
      stripeCredentials: null,
    };

    const decrypted = withDecryptedProjectCredentials(row, KEY);

    expect(decrypted).not.toBeNull();
    expect(decrypted!.appleCredentials).toEqual(apple);
    expect(decrypted!.googleCredentials).toEqual(google);
    expect(decrypted!.stripeCredentials).toBeNull();
  });

  test("returns null when the row is null", () => {
    expect(withDecryptedProjectCredentials(null, KEY)).toBeNull();
  });
});
