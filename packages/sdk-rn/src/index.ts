import { SDK_VERSION } from "./version";

export { SDK_VERSION };

export type RovenueConfig = {
  apiKey: string;
  baseUrl: string;
  debug?: boolean;
};

export type RovenueHandle = {
  getVersion(): string;
};

class RovenueStub implements RovenueHandle {
  constructor(public readonly config: Readonly<RovenueConfig>) {}
  getVersion(): string {
    return SDK_VERSION;
  }
}

export function configure(config: RovenueConfig): RovenueHandle {
  if (!config.apiKey || config.apiKey.trim() === "") {
    throw new Error("Rovenue: invalid api key");
  }
  if (!/^https?:\/\//.test(config.baseUrl)) {
    throw new Error("Rovenue: base_url must be http(s)");
  }
  return new RovenueStub({ debug: false, ...config });
}

export function getVersion(): string {
  return SDK_VERSION;
}
