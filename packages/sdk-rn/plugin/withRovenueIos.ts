// withRovenueIos — Expo config plugin mod that injects the M3 Swift
// pod into the consumer's Podfile so RovenueModule (sdk-rn's bridge)
// can link against it.
//
// M6 hard-codes the monorepo-relative path. M7 will support an
// option-driven external path and/or a Trunk-published pod.

import { ConfigPlugin, withDangerousMod } from "@expo/config-plugins";
import * as fs from "node:fs";
import * as path from "node:path";

type Options = { rovenueSwiftPath?: string } | undefined;

export const withRovenueIos: ConfigPlugin<Options> = (config, opts) => {
  return withDangerousMod(config, ["ios", async (cfg) => {
    const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
    if (!fs.existsSync(podfile)) return cfg;

    const contents = fs.readFileSync(podfile, "utf8");
    if (contents.includes("pod 'Rovenue'")) return cfg;

    const rovenuePath = opts?.rovenueSwiftPath ?? "../../../packages/sdk-swift";
    const podLine = `  pod 'Rovenue', :path => '${rovenuePath}'`;

    // Inject after the first `target 'XYZ' do` line.
    const patched = contents.replace(
      /(target\s+['"][^'"]+['"]\s+do)/,
      `$1\n${podLine}`,
    );
    fs.writeFileSync(podfile, patched);
    return cfg;
  }]);
};
