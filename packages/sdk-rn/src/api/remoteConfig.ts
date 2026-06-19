import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { ExperimentAssignment, RemoteConfig } from "../types";

export const EMPTY_REMOTE_CONFIG: RemoteConfig = Object.freeze({
  flags: {},
  experiments: {},
});

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

/**
 * Parse the native `remoteConfigAllJson()` payload into a `RemoteConfig`.
 * Tolerant by design: a malformed/empty payload yields the empty config so a
 * read never throws.
 */
export function parseRemoteConfig(json: string): RemoteConfig {
  try {
    const parsed = JSON.parse(json) as Partial<RemoteConfig>;
    return {
      flags: parsed.flags ?? {},
      experiments: parsed.experiments ?? {},
    };
  } catch {
    return EMPTY_REMOTE_CONFIG;
  }
}

/** Force an immediate fetch of the latest Remote Config from the server. */
export async function refreshRemoteConfig(): Promise<void> {
  return call(() => getNative().refreshRemoteConfig());
}

/** The whole `{ flags, experiments }` bundle, fetched from the local cache. */
export async function getRemoteConfig(): Promise<RemoteConfig> {
  return call(async () => parseRemoteConfig(await getNative().remoteConfigAllJson()));
}

/**
 * Read one flag with a typed fallback. The fallback's runtime type selects the
 * native getter (boolean/number/string); anything else falls back to a parsed
 * JSON read so object/array flags resolve too.
 */
export async function getFlag<T>(key: string, fallback: T): Promise<T> {
  return call(async () => {
    const native = getNative();
    if (typeof fallback === "boolean") {
      return (await native.remoteConfigBool(key, fallback)) as unknown as T;
    }
    if (typeof fallback === "number") {
      return (await native.remoteConfigDouble(key, fallback)) as unknown as T;
    }
    if (typeof fallback === "string") {
      return (await native.remoteConfigString(key, fallback)) as unknown as T;
    }
    const raw = await native.remoteConfigJson(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  });
}

/** The current subscriber's assignment for one experiment, or `null`. */
export async function getExperiment(
  key: string,
): Promise<ExperimentAssignment | null> {
  return call(async () => {
    const dto = await getNative().experiment(key);
    if (!dto) return null;
    return mapExperiment(dto);
  });
}

/** All of the current subscriber's experiment assignments. */
export async function getExperiments(): Promise<ExperimentAssignment[]> {
  return call(async () => (await getNative().experimentsAll()).map(mapExperiment));
}

function mapExperiment(dto: {
  experimentId: string;
  key: string;
  variantId: string;
  variantName: string;
  valueJson: string;
}): ExperimentAssignment {
  let value: unknown = null;
  try {
    value = JSON.parse(dto.valueJson);
  } catch {
    value = null;
  }
  return {
    experimentId: dto.experimentId,
    key: dto.key,
    variantId: dto.variantId,
    variantName: dto.variantName,
    value,
  };
}
