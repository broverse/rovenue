export const REFERRER_KEY = "rovenue_funnel_token";

export function buildInstallReferrer(token: string): string {
  return `${REFERRER_KEY}%3D${encodeURIComponent(token)}`;
}

export function parseInstallReferrer(raw: string): string | null {
  if (!raw || raw.trim().length === 0) return null;
  const params = new URLSearchParams(raw);
  const value = params.get(REFERRER_KEY);
  return value && value.length > 0 ? value : null;
}
