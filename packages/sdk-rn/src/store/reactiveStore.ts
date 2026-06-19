// ReactiveStore — in-memory cache mirror. Hook reads come out of this
// synchronously via useSyncExternalStore; the event bridge mutates it
// when the native core emits a ChangeEvent.
//
// Slot keys are flat strings. Per-entitlement slots use the pattern
// `entitlement:<id>` so we can look up one without scanning a list.

import type { Entitlement, RemoteConfig, User } from "../types";

type StoreSlot =
  | "user"
  | "creditBalance"
  | "entitlementsAll"
  | "remoteConfig"
  | `entitlement:${string}`;

type StoreValue =
  | User
  | number
  | Entitlement
  | Entitlement[]
  | RemoteConfig
  | null;

export class ReactiveStore {
  private values = new Map<StoreSlot, StoreValue>();
  private listeners = new Set<() => void>();

  get<T = StoreValue>(slot: StoreSlot): T | undefined {
    return this.values.get(slot) as T | undefined;
  }

  set<T extends StoreValue>(slot: StoreSlot, value: T): void {
    this.values.set(slot, value);
    this.listeners.forEach((l) => l());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.values.clear();
    this.listeners.forEach((l) => l());
  }
}

// Module singleton used by every hook + the event bridge.
export const store = new ReactiveStore();
