import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

// =============================================================
// AES-256-GCM authenticated encryption
// =============================================================
//
// Wire format: `${ivB64}:${tagB64}:${dataB64}` — a single string safe
// to store in a text column or serialise to JSON.
//
// Keys are 32 raw bytes encoded as a 64-char hex string (matching the
// ENCRYPTION_KEY env variable format). Every call uses a fresh random
// 12-byte IV, so encrypting the same plaintext twice produces two
// distinct ciphertexts.

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKey(hexKey: string): Buffer {
  if (typeof hexKey !== "string" || hexKey.length === 0) {
    throw new Error("encryption key is required");
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(hexKey, "hex");
  } catch {
    throw new Error("encryption key must be a hex string");
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `encryption key must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

export function encrypt(plaintext: string, hexKey: string): string {
  const key = loadKey(hexKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

export function decrypt(ciphertext: string, hexKey: string): string {
  const key = loadKey(hexKey);
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("ciphertext must be iv:tag:data");
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  if (iv.length !== IV_BYTES) {
    throw new Error("invalid iv length");
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error("invalid auth tag length");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}

export function encryptJson<T>(value: T, hexKey: string): string {
  return encrypt(JSON.stringify(value), hexKey);
}

export function decryptJson<T>(ciphertext: string, hexKey: string): T {
  return JSON.parse(decrypt(ciphertext, hexKey)) as T;
}

export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString("hex");
}

export function getKeyFromEnv(
  envVar = "ENCRYPTION_KEY",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = env[envVar];
  if (!key) {
    throw new Error(`${envVar} is not set`);
  }
  loadKey(key);
  return key;
}

export function isEncryptedString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  if (parts.length !== 3) return false;
  try {
    return (
      Buffer.from(parts[0]!, "base64").length === IV_BYTES &&
      Buffer.from(parts[1]!, "base64").length === TAG_BYTES &&
      parts[2]!.length > 0
    );
  } catch {
    return false;
  }
}
