// Opaque cursor carrying the last row's (createdAt, id) so the
// next page of `ORDER BY createdAt DESC, id DESC` picks up exactly
// where the previous one left off. We encode with base64url so it's
// URL-safe without extra encoding.

export interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  const payload = JSON.stringify({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !json ||
    typeof json !== "object" ||
    typeof (json as { createdAt?: unknown }).createdAt !== "string" ||
    typeof (json as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  const parsed = json as { createdAt: string; id: string };
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: parsed.id };
}
