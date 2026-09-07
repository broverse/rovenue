// See scripts/vitest/jsdom-node26-storage.ts — Node >= 26 shadows jsdom's
// `localStorage`, which silently breaks every test touching the persisted
// paywall anchor (`resolvePersistedFirstShownAt`).
import "../../../scripts/vitest/jsdom-node26-storage";
