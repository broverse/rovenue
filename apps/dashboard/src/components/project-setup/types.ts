export type SetupMode = "create" | "update";

export type PlatformId = "ios" | "android" | "stripe";

export type FxSourceId = "ecb";

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

export interface SetupForm {
  name: string;
  desc: string;
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
}

export interface StepDefinition {
  id: number;
  key: "basics" | "platforms" | "currency" | "review";
}

export interface PlatformDefinition {
  id: PlatformId;
  bg: string;
  txt: string;
}
