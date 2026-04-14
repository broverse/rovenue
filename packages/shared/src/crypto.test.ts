import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  generateKey,
} from "./crypto";

const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("hex");

describe("encrypt / decrypt", () => {
  test("round-trips a plaintext string", () => {
    const plaintext = "hunter2 — with unicode ✓ and newlines\nok";

    const ciphertext = encrypt(plaintext, KEY_A);
    const recovered = decrypt(ciphertext, KEY_A);

    expect(recovered).toBe(plaintext);
  });

  test("decrypt with a different key throws", () => {
    const ciphertext = encrypt("secret", KEY_A);

    expect(() => decrypt(ciphertext, KEY_B)).toThrow();
  });

  test("produces a different ciphertext each call for identical input", () => {
    const plaintext = "same input";

    const a = encrypt(plaintext, KEY_A);
    const b = encrypt(plaintext, KEY_A);

    expect(a).not.toBe(b);
    expect(decrypt(a, KEY_A)).toBe(plaintext);
    expect(decrypt(b, KEY_A)).toBe(plaintext);
  });

  test("ciphertext is a base64 iv:tag:data triple", () => {
    const out = encrypt("x", KEY_A);
    const parts = out.split(":");

    expect(parts).toHaveLength(3);
    for (const p of parts) {
      expect(Buffer.from(p, "base64").toString("base64")).toBe(p);
    }
    // 12-byte IV → 16 base64 chars
    expect(Buffer.from(parts[0]!, "base64")).toHaveLength(12);
    // 16-byte GCM tag
    expect(Buffer.from(parts[1]!, "base64")).toHaveLength(16);
  });

  test("tampered ciphertext fails authentication", () => {
    const ciphertext = encrypt("immutable", KEY_A);
    const [iv, tag, data] = ciphertext.split(":");
    const flipped = Buffer.from(data!, "base64");
    flipped[0] = flipped[0]! ^ 0x01;
    const tampered = `${iv}:${tag}:${flipped.toString("base64")}`;

    expect(() => decrypt(tampered, KEY_A)).toThrow();
  });

  test("rejects keys that are not 32 bytes", () => {
    const shortKey = randomBytes(16).toString("hex");

    expect(() => encrypt("x", shortKey)).toThrow(/32 bytes/);
  });
});

describe("encryptJson / decryptJson", () => {
  test("round-trips an object", () => {
    const obj = { packageName: "com.example", nested: { n: 1 } };

    const ciphertext = encryptJson(obj, KEY_A);
    const recovered = decryptJson<typeof obj>(ciphertext, KEY_A);

    expect(recovered).toEqual(obj);
  });
});

describe("generateKey", () => {
  test("returns a 32-byte hex string", () => {
    const key = generateKey();

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(key, "hex")).toHaveLength(32);
  });

  test("returns a different key each call", () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});
