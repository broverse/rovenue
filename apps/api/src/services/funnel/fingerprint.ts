import { createHash } from "node:crypto";

export interface FingerprintInput {
  ip: string;
  userAgent: string;
  locale: string;
  timezone: string;
  screenDims: string;
  deviceModel?: string | null;
}

export interface NormalizedFingerprint {
  ipHash: string;
  userAgent: string;
  locale: string;
  timezone: string;
  screenDims: string;
  deviceModel: string | null;
}

const SALT = process.env.FUNNEL_FINGERPRINT_SALT ?? "rovenue-fp-default-salt";

export function hashIp(ip: string): string {
  return createHash("sha256").update(`${SALT}:${ip}`).digest("hex");
}

export function normalizeFingerprint(input: FingerprintInput): NormalizedFingerprint {
  return {
    ipHash: hashIp(input.ip.trim()),
    userAgent: input.userAgent.trim().slice(0, 256),
    // Lowercase so `en-US` (Accept-Language) and `en_US` (SDK) compare equal.
    locale: input.locale.trim().replace(/_/g, "-").toLowerCase(),
    timezone: input.timezone.trim(),
    screenDims: input.screenDims.replace(/\s+/g, "").toLowerCase(),
    deviceModel: input.deviceModel ? input.deviceModel.trim() : null,
  };
}

export function fingerprintsMatch(
  a: NormalizedFingerprint,
  b: NormalizedFingerprint,
): boolean {
  if (a.ipHash !== b.ipHash) return false;
  if (a.locale !== b.locale) return false;
  // Empty timezone is the "unknown" sentinel (the server has no device tz for
  // an iOS deferred/universal-link hit) — skip the axis when either side is
  // unknown, mirroring the `0x0` screen-dims sentinel. Without this, a device
  // not literally in UTC never matched.
  if (a.timezone !== "" && b.timezone !== "" && a.timezone !== b.timezone) {
    return false;
  }
  if (a.screenDims !== "0x0" && b.screenDims !== "0x0" && a.screenDims !== b.screenDims) {
    return false;
  }
  if (a.deviceModel && b.deviceModel && a.deviceModel !== b.deviceModel) return false;
  return true;
}
