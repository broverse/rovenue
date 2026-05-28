const PII_KEYS = new Set([
  "email",
  "name",
  "fullName",
  "firstName",
  "lastName",
  "ip",
  "ipAddress",
  "phone",
  "phoneNumber",
  "customAttributes",
  "billingAddress",
  "deviceId",
]);

export function sterilizeToolResult<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(walk);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (PII_KEYS.has(k)) continue;
    out[k] = walk(v);
  }
  return out;
}
