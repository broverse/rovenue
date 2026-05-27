// Fixture helpers for Expo config plugin mod tests.
//
// withDangerousMod resolves a promise from the supplied callback; the
// callback receives a `cfg` with `modRequest.platformProjectRoot`
// pointing at the consumer's `ios/` directory. We simulate that by
// writing a Podfile to a tmp dir, running the plugin against a synthetic
// config, then reading the Podfile back.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MIN_PODFILE = `platform :ios, '13.0'
require_relative '../node_modules/react-native/scripts/react_native_pods'

target 'sampleApp' do
  use_expo_modules!
  config = use_native_modules!
  use_react_native!(:path => config[:reactNativePath])
end
`;

export const PODFILE_WITHOUT_TARGET = `platform :ios, '13.0'
# no target block — plugin should leave this Podfile untouched.
`;

/**
 * Write `podfileContents` to a tmp `<scratch>/ios/Podfile`, return the
 * scratch dir path. The caller passes the scratch dir as
 * `platformProjectRoot` when constructing the synthetic Expo config.
 */
export function makePodfileScratch(podfileContents: string): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rovenue-plugin-fixture-"));
  fs.mkdirSync(path.join(scratch, "ios"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "ios", "Podfile"), podfileContents);
  return scratch;
}

/**
 * Read the patched Podfile back from a scratch dir.
 * Returns the file contents (string).
 */
export function readPodfile(scratch: string): string {
  return fs.readFileSync(path.join(scratch, "ios", "Podfile"), "utf8");
}

/**
 * Read the Podfile if it exists; return null if missing.
 * Used to verify the "no Podfile = no crash" branch.
 */
export function readPodfileOrNull(scratch: string): string | null {
  const p = path.join(scratch, "ios", "Podfile");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

/**
 * Construct a minimal synthetic Expo config object that withDangerousMod
 * understands. `platformProjectRoot` points at `<scratch>/ios`.
 *
 * `@expo/config-plugins`' `withDangerousMod` does most of its work at
 * `compileModsAsync` time (called by `expo prebuild`). For unit testing
 * we extract and invoke the callback directly.
 */
export type FakeExpoConfig = {
  name: string;
  slug: string;
  mods?: any;
};

export function makeFakeConfig(): FakeExpoConfig {
  return { name: "test", slug: "test" };
}

/**
 * Invoke the iOS dangerous-mod callback registered by `withRovenueIos`.
 * Returns the (mutated) config the callback returns.
 *
 * Implementation note: `withDangerousMod(config, ["ios", cb])` mutates
 * `config.mods.ios.dangerous = cb` and returns config. We invoke `cb`
 * with a stub `modRequest` so the file system mutation happens.
 */
export async function runIosDangerousMod(
  config: any,
  platformProjectRoot: string,
): Promise<any> {
  // The plugin attaches the callback at config.mods.ios.dangerous
  const cb = config?.mods?.ios?.dangerous;
  if (typeof cb !== "function") {
    throw new Error(
      "no ios dangerous mod registered — did the plugin run withDangerousMod?",
    );
  }
  // The plugin reads `path.join(platformProjectRoot, "Podfile")`, so
  // `platformProjectRoot` per Expo convention is the consumer's `ios/`
  // directory (where the Podfile lives). Callers pass the scratch root
  // and we resolve `<scratch>/ios` here so the fixture API stays simple.
  const stubCfg = {
    ...config,
    modRequest: {
      platformProjectRoot: path.join(platformProjectRoot, "ios"),
    },
  };
  return cb(stubCfg);
}
