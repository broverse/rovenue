/**
 * Writes the funnel token to the clipboard as `rovenue-funnel:<token>` so the
 * iOS app can recover it on first launch (NativeLink-style deferred deep link).
 * Best-effort: clipboard writes can reject (permission / insecure context) — we
 * swallow the error because the user can still recover via deep link or email.
 * Must be called from a user-gesture handler (the open-app CTA).
 */
export async function writeFunnelTokenToClipboard(token: string): Promise<void> {
  try {
    await navigator?.clipboard?.writeText(`rovenue-funnel:${token}`);
  } catch {
    // ignore — deferred recovery degrades to deep link / email
  }
}
