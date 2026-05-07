import type {
  ConnectorDefinition,
  PlatformDefinition,
  RoleDefinition,
  SetupForm,
  StepDefinition,
} from "./types";

export const STEPS: ReadonlyArray<StepDefinition> = [
  { id: 1, key: "basics" },
  { id: 2, key: "platforms" },
  { id: 3, key: "currency" },
  { id: 4, key: "connectors" },
  { id: 5, key: "team" },
  { id: 6, key: "review" },
];

export const PLATFORMS: ReadonlyArray<PlatformDefinition> = [
  { id: "ios", bg: "#0A84FF", txt: "iOS" },
  { id: "android", bg: "#3DDC84", txt: "PS" },
  { id: "web", bg: "#635BFF", txt: "Sw" },
  { id: "paddle", bg: "#0A0F19", txt: "Pd" },
  { id: "amazon", bg: "#FF9900", txt: "Am" },
  { id: "roku", bg: "#673AB7", txt: "Ro" },
];

export const CONNECTORS: ReadonlyArray<ConnectorDefinition> = [
  { id: "amplitude", name: "Amplitude", meta: "Analytics", bg: "#1E61F0" },
  { id: "mixpanel", name: "Mixpanel", meta: "Analytics", bg: "#7856FF" },
  { id: "segment", name: "Segment", meta: "CDP", bg: "#52BD94" },
  { id: "rudderstack", name: "RudderStack", meta: "CDP", bg: "#3B82F6" },
  { id: "snowflake", name: "Snowflake", meta: "Warehouse", bg: "#29B5E8" },
  { id: "bigquery", name: "BigQuery", meta: "Warehouse", bg: "#669DF6" },
  { id: "slack", name: "Slack", meta: "Alerts", bg: "#4A154B" },
  { id: "pagerduty", name: "PagerDuty", meta: "Alerts", bg: "#06AC38" },
  { id: "webhook", name: "Generic Webhook", meta: "HTTP", bg: "#52525B" },
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

export const ROLES: ReadonlyArray<RoleDefinition> = [
  { id: "owner" },
  { id: "admin" },
  { id: "analyst" },
  { id: "developer" },
  { id: "viewer" },
];

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
  slug: "",
  desc: "",
  env: "production",
  icon: "",
  iconColor: "#3B82F6",
  platforms: [],
  bundleId: "",
  androidPackage: "",
  storeIssuer: "",
  storeKeyId: "",
  stripeAcct: "",
  currency: "USD",
  fxSource: "ecb",
  timezone: "UTC",
  weekStart: "monday",
  fiscalMonth: "jan",
  connectors: [],
  sandbox: false,
  autoImport: true,
  refundPolicy: "partial-window",
  members: [],
  tags: [],
};
