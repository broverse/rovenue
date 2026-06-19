import { useEffect, useState } from "react";

/**
 * Returns `value` only after it has stayed unchanged for `delayMs`.
 * Each change restarts the timer, so transient intermediate values are skipped.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
