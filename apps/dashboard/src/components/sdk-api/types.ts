import type { LucideIcon } from "lucide-react";

export type PlatformId = "ios" | "android" | "react-native" | "web" | "rest";

export type PlatformDescriptor = {
  id: PlatformId;
  /** i18n key suffix under `sdkApi.quickstart.platforms`. */
  labelKey: string;
  language: string;
  installCommand: string;
  installFilename: string;
  initSnippet: string;
  initFilename: string;
  initLanguage: string;
};

export type SdkPackageStatus = "stable" | "beta" | "preview" | "planned";

export type SdkPackage = {
  id: string;
  /** i18n key suffix under `sdkApi.packages.items`. */
  nameKey: string;
  /** i18n key suffix under `sdkApi.packages.targets`. */
  targetKey: string;
  icon: LucideIcon;
  iconClass: string;
  version: string;
  publishedKey: string;
  status: SdkPackageStatus;
  install: string;
  installLanguage: string;
  repoLabel: string;
  docsKey: string;
};

export type ProjectSecretKind = "publishable" | "secret" | "webhook";

export type ProjectSecret = {
  id: string;
  kind: ProjectSecretKind;
  /** i18n key suffix under `sdkApi.keys.items`. */
  labelKey: string;
  value: string;
  /** Truncated/preview value used when the secret is hidden. */
  preview: string;
  createdKey: string;
  /** i18n key suffix under `sdkApi.keys.environments`. */
  environmentKey: "production" | "sandbox";
};

export type RestMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type RestEndpoint = {
  id: string;
  method: RestMethod;
  path: string;
  /** i18n key suffix under `sdkApi.endpoints.items`. */
  summaryKey: string;
  /** i18n key suffix under `sdkApi.endpoints.scopes`. */
  scopeKey: "read" | "write" | "admin";
};

export type WebhookDelivery = {
  id: string;
  status: "ok" | "retry" | "failed";
  /** i18n key suffix under `sdkApi.webhooks.events`. */
  eventKey: string;
  latencyMs: number;
  ageKey: string;
};

export type ResourceLink = {
  id: string;
  /** i18n key suffix under `sdkApi.resources.items`. */
  labelKey: string;
  /** i18n key suffix under `sdkApi.resources.descriptions`. */
  descriptionKey: string;
  href: string;
  icon: LucideIcon;
};

export type SdkHeroStats = {
  callsValue: string;
  callsUnit: string;
  callsDescriptionKey: string;
  callsDescriptionVars?: Record<string, string | number>;
  successValue: string;
  successUnit: string;
  successDescriptionKey: string;
  latencyValue: string;
  latencyUnit: string;
  latencyDescriptionKey: string;
  installsValue: string;
  installsUnit: string;
  installsDescriptionKey: string;
};
