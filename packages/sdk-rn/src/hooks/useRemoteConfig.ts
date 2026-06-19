import { useEffect, useSyncExternalStore } from "react";
import { getNative } from "../core/native";
import { store } from "../store/reactiveStore";
import { EMPTY_REMOTE_CONFIG, parseRemoteConfig } from "../api/remoteConfig";
import type { ExperimentAssignment, RemoteConfig } from "../types";

function loadIfNeeded(): void {
  if (store.get("remoteConfig") === undefined) {
    getNative()
      .remoteConfigAllJson()
      .then((json) => store.set("remoteConfig", parseRemoteConfig(json)))
      .catch(() => {});
  }
}

function read(): RemoteConfig {
  return store.get<RemoteConfig>("remoteConfig") ?? EMPTY_REMOTE_CONFIG;
}

/**
 * Reactive Remote Config. Returns the whole `{ flags, experiments }` bundle and
 * re-renders whenever the native core emits `REMOTE_CONFIG_CHANGED`. Reads are
 * synchronous off the local cache; the first mount lazily primes it.
 */
export function useRemoteConfig(): RemoteConfig {
  useEffect(loadIfNeeded, []);
  return useSyncExternalStore(
    store.subscribe.bind(store),
    read,
    () => EMPTY_REMOTE_CONFIG,
  );
}

/** Reactive single-flag read with a typed fallback. */
export function useFlag<T>(key: string, fallback: T): T {
  const config = useRemoteConfig();
  const value = config.flags[key];
  return (value === undefined ? fallback : value) as T;
}

/** Reactive single-experiment assignment for the current subscriber. */
export function useExperiment(key: string): ExperimentAssignment | null {
  const config = useRemoteConfig();
  return config.experiments[key] ?? null;
}
