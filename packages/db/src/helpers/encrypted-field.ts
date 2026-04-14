import {
  decryptJson,
  encryptJson,
  isEncryptedString,
} from "@rovenue/shared";

// =============================================================
// Encrypted JSON fields on the Project row
// =============================================================
//
// Credentials are stored as Prisma `Json?` columns. When encryption
// is active we replace the plaintext object with a tagged wrapper
// `{ v: 1, enc: "iv:tag:data" }` so callers can tell encrypted rows
// apart from legacy plaintext rows (which still decrypt as a pass-
// through during the migration window).

const CREDENTIAL_FIELDS = [
  "appleCredentials",
  "googleCredentials",
  "stripeCredentials",
] as const;

type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

export interface EncryptedCredential {
  readonly v: 1;
  readonly enc: string;
}

export function isEncryptedCredential(
  value: unknown,
): value is EncryptedCredential {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return obj.v === 1 && isEncryptedString(obj.enc);
}

export function encryptCredential<T>(
  value: T,
  hexKey: string,
): EncryptedCredential {
  return { v: 1, enc: encryptJson(value, hexKey) };
}

export function decryptCredential<T>(
  field: unknown,
  hexKey: string,
): T | null {
  if (field === null || field === undefined) return null;
  if (isEncryptedCredential(field)) {
    return decryptJson<T>(field.enc, hexKey);
  }
  // Plaintext fallback — rows written before encryption was wired.
  return field as T;
}

type ProjectCredentialsInput = {
  appleCredentials?: unknown;
  googleCredentials?: unknown;
  stripeCredentials?: unknown;
  [key: string]: unknown;
};

export function encryptProjectCredentials<T extends ProjectCredentialsInput>(
  input: T,
  hexKey: string,
): T {
  const out = { ...input } as Record<string, unknown>;
  for (const field of CREDENTIAL_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value === null || value === undefined) {
      out[field] = value ?? null;
      continue;
    }
    if (isEncryptedCredential(value)) {
      out[field] = value;
      continue;
    }
    out[field] = encryptCredential(value, hexKey);
  }
  return out as T;
}

export function withDecryptedProjectCredentials<
  T extends ProjectCredentialsInput,
>(row: T | null, hexKey: string): T | null {
  if (row === null) return null;
  const out = { ...row } as Record<string, unknown>;
  for (const field of CREDENTIAL_FIELDS) {
    if (!(field in row)) continue;
    out[field] = decryptCredential(row[field], hexKey);
  }
  return out as T;
}

export function decryptProjectCredentialField<T>(
  row: Record<CredentialField, unknown> | null,
  field: CredentialField,
  hexKey: string,
): T | null {
  if (row === null) return null;
  return decryptCredential<T>(row[field], hexKey);
}
