import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

const ALG = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export interface EncryptedBlob {
  readonly v: 1;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

function getKey(): Buffer {
  if (!env.ENCRYPTION_KEY) {
    throw new Error(
      "ENCRYPTION_KEY is not configured — cannot encrypt/decrypt credentials",
    );
  }
  const buf = Buffer.from(env.ENCRYPTION_KEY, "hex");
  if (buf.length !== KEY_LENGTH) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes`);
  }
  return buf;
}

/**
 * AES-256-GCM authenticated encryption. Returns a serialisable blob
 * (iv + auth tag + ciphertext, base64-encoded) that round-trips through
 * the database as a JSON field.
 */
export function encrypt(plaintext: string): EncryptedBlob {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
}

export function decrypt(blob: EncryptedBlob): string {
  const key = getKey();
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ciphertext = Buffer.from(blob.data, "base64");
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function encryptJson<T>(obj: T): EncryptedBlob {
  return encrypt(JSON.stringify(obj));
}

export function decryptJson<T>(blob: EncryptedBlob): T {
  return JSON.parse(decrypt(blob)) as T;
}

export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.v === 1 &&
    typeof obj.iv === "string" &&
    typeof obj.tag === "string" &&
    typeof obj.data === "string"
  );
}
