export type SetupMode = "create" | "update";

export type EnvironmentId = "production" | "staging" | "sandbox";

export type PlatformId =
  | "ios"
  | "android"
  | "web"
  | "paddle"
  | "amazon"
  | "roku";

export type FxSourceId = "ecb" | "oanda" | "custom";

export type WeekStart = "monday" | "sunday" | "saturday";

export type FiscalMonth =
  | "jan"
  | "feb"
  | "mar"
  | "apr"
  | "may"
  | "jun"
  | "jul"
  | "aug"
  | "sep"
  | "oct"
  | "nov"
  | "dec";

export type RefundPolicy = "partial-window" | "full-clawback";

export type RoleId = "owner" | "admin" | "analyst" | "developer" | "viewer";

export interface SetupMember {
  email: string;
  role: RoleId;
  name: string;
}

export interface SetupForm {
  name: string;
  slug: string;
  desc: string;
  env: EnvironmentId;
  icon: string;
  iconColor: string;
  platforms: PlatformId[];
  bundleId: string;
  androidPackage: string;
  storeIssuer: string;
  storeKeyId: string;
  stripeAcct: string;
  currency: string;
  fxSource: FxSourceId;
  timezone: string;
  weekStart: WeekStart;
  fiscalMonth: FiscalMonth;
  connectors: string[];
  sandbox: boolean;
  autoImport: boolean;
  refundPolicy: RefundPolicy;
  members: SetupMember[];
  tags: string[];
}

export interface StepDefinition {
  id: number;
  key: "basics" | "platforms" | "currency" | "connectors" | "team" | "review";
}

export interface PlatformDefinition {
  id: PlatformId;
  bg: string;
  txt: string;
}

export interface ConnectorDefinition {
  id: string;
  name: string;
  meta: string;
  bg: string;
}

export interface RoleDefinition {
  id: RoleId;
}
