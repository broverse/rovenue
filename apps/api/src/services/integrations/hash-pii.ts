import { createHash } from "node:crypto";

export function hashPii(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  return createHash("sha256").update(trimmed, "utf8").digest("hex");
}

export function normalizeEmail(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  return t.length === 0 ? undefined : t;
}

export function normalizePhone(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const digits = v.replace(/[^0-9]/g, "");
  return digits.length === 0 ? undefined : digits;
}

export function normalizeExternalId(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}
