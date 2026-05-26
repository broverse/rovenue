// =============================================================
// Funnel runtime cache — stub
// =============================================================
//
// Phase 5 ships only the route surface for publish/duplicate/etc.
// The real Redis-backed bundle cache lands in Phase 6 Task 27 along
// with the public runtime config endpoint. Leaving the helpers as
// no-ops here keeps the publish flow callable end-to-end while the
// runtime cache is still being designed; once Phase 6 lands every
// call site here will be wired to a real client without changing
// signatures.

export async function invalidatePublishedConfig(_slug: string): Promise<void> {
  // Implementation lands in Phase 6 Task 27 with the Redis client wiring.
}

export async function readPublishedConfig<T>(_slug: string): Promise<T | null> {
  return null;
}

export async function writePublishedConfig(
  _slug: string,
  _value: unknown,
): Promise<void> {
  // No-op until Phase 6 wires Redis.
}
