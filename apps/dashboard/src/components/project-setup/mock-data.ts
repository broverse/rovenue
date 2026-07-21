import type {
  PlatformDefinition,
  SetupForm,
  StepDefinition,
} from "./types";

export const STEPS: ReadonlyArray<StepDefinition> = [
  { id: 1, key: "basics" },
  { id: 2, key: "platforms" },
  { id: 3, key: "currency" },
  { id: 4, key: "review" },
];

export const PLATFORMS: ReadonlyArray<PlatformDefinition> = [
  { id: "ios", bg: "#0A84FF", txt: "iOS" },
  { id: "android", bg: "#3DDC84", txt: "PS" },
  { id: "stripe", bg: "#635BFF", txt: "St" },
];

export const CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "TRY",
  "BRL",
  "INR",
  "AUD",
  "CAD",
  "CHF",
] as const;

export const TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "America/Chicago",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Istanbul",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Australia/Sydney",
] as const;

export const FISCAL_MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

export const ICON_COLORS: ReadonlyArray<string> = [
  "#3B82F6",
  "#8B5CF6",
  "#10B981",
  "#F59E0B",
  "#EC4899",
  "#52525B",
];

export const EMPTY_FORM: SetupForm = {
  name: "",
  desc: "",
  icon: "",
  iconColor: "#3B82F6",
  platforms: [],
  bundleId: "",
  androidPackage: "",
  storeIssuer: "",
  storeKeyId: "",
  currency: "USD",
  fxSource: "ecb",
  timezone: "UTC",
  weekStart: "monday",
  fiscalMonth: "jan",
};
