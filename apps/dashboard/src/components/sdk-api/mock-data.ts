import {
  Apple,
  BookOpen,
  Cloud,
  Compass,
  FileCode2,
  FolderGit2,
  Globe,
  Server,
  ShieldCheck,
  Smartphone,
  Terminal,
  Zap,
} from "lucide-react";
import type {
  PlatformDescriptor,
  ProjectSecret,
  ResourceLink,
  RestEndpoint,
  SdkHeroStats,
  SdkPackage,
  WebhookDelivery,
} from "./types";

export const API_BASE_URL = "https://api.rovenue.io/v1";

export const HERO_STATS: SdkHeroStats = {
  callsValue: "412.6",
  callsUnit: "k",
  callsDescriptionKey: "sdkApi.hero.stats.callsDescription",
  callsDescriptionVars: { delta: "+8.4%" },
  successValue: "99.97",
  successUnit: "%",
  successDescriptionKey: "sdkApi.hero.stats.successDescription",
  latencyValue: "118",
  latencyUnit: "ms",
  latencyDescriptionKey: "sdkApi.hero.stats.latencyDescription",
  installsValue: "23.4",
  installsUnit: "k",
  installsDescriptionKey: "sdkApi.hero.stats.installsDescription",
};

export const PLATFORMS: ReadonlyArray<PlatformDescriptor> = [
  {
    id: "react-native",
    labelKey: "reactNative",
    language: "bash",
    installCommand: "pnpm add @rovenue/react-native",
    installFilename: "terminal",
    initSnippet: `import { Rovenue } from "@rovenue/react-native";

await Rovenue.configure({
  publicKey: "rvn_pk_live_…",
  appUserId: user.id,
});

const offerings = await Rovenue.getOfferings();`,
    initFilename: "App.tsx",
    initLanguage: "tsx",
  },
  {
    id: "ios",
    labelKey: "ios",
    language: "swift",
    installCommand: ".package(url: \"https://github.com/rovenue/rovenue-ios\", from: \"0.9.3\")",
    installFilename: "Package.swift",
    initSnippet: `import Rovenue

Rovenue.configure(
  publicKey: "rvn_pk_live_…",
  appUserId: user.id
)

let offerings = try await Rovenue.shared.getOfferings()`,
    initFilename: "AppDelegate.swift",
    initLanguage: "swift",
  },
  {
    id: "android",
    labelKey: "android",
    language: "kotlin",
    installCommand: "implementation(\"io.rovenue:rovenue-android:0.9.3\")",
    installFilename: "build.gradle.kts",
    initSnippet: `import io.rovenue.Rovenue

Rovenue.configure(
  publicKey = "rvn_pk_live_…",
  appUserId = user.id,
)

val offerings = Rovenue.shared.getOfferings()`,
    initFilename: "Application.kt",
    initLanguage: "kotlin",
  },
  {
    id: "web",
    labelKey: "web",
    language: "bash",
    installCommand: "pnpm add @rovenue/web",
    installFilename: "terminal",
    initSnippet: `import { Rovenue } from "@rovenue/web";

const rv = new Rovenue({
  publicKey: "rvn_pk_live_…",
  appUserId: user.id,
});

const offerings = await rv.offerings();`,
    initFilename: "rovenue.ts",
    initLanguage: "ts",
  },
  {
    id: "rest",
    labelKey: "rest",
    language: "bash",
    installCommand: `curl ${API_BASE_URL}/health \\
  -H "Authorization: Bearer rvn_sk_live_…"`,
    installFilename: "terminal",
    initSnippet: `curl ${API_BASE_URL}/subscribers/usr_42 \\
  -H "Authorization: Bearer rvn_sk_live_…" \\
  -H "Rovenue-Version: 2026-04-01"`,
    initFilename: "terminal",
    initLanguage: "bash",
  },
];

export const PROJECT_SECRETS: ReadonlyArray<ProjectSecret> = [
  {
    id: "pk-prod",
    kind: "publishable",
    labelKey: "publishableProd",
    value: "rvn_pk_live_4f8a1c97e23d49bcb6027f6c7a32c1ed",
    preview: "rvn_pk_live_4f8a…c1ed",
    createdKey: "createdAtProd",
    environmentKey: "production",
  },
  {
    id: "pk-sandbox",
    kind: "publishable",
    labelKey: "publishableSandbox",
    value: "rvn_pk_test_2b16e08a7c4f47bda73e9123e51d92ab",
    preview: "rvn_pk_test_2b16…92ab",
    createdKey: "createdAtSandbox",
    environmentKey: "sandbox",
  },
  {
    id: "sk-prod",
    kind: "secret",
    labelKey: "secretProd",
    value: "rvn_sk_live_b1c3d40e9842471aa1f6e7c5a82e7d34",
    preview: "rvn_sk_live_•••••••••••••",
    createdKey: "createdAtProd",
    environmentKey: "production",
  },
  {
    id: "wh-signing",
    kind: "webhook",
    labelKey: "webhookSigning",
    value: "whsec_3b94c0f7aa8b4d2c9b6e1f4d2a73c0e8",
    preview: "whsec_3b94…c0e8",
    createdKey: "createdAtProd",
    environmentKey: "production",
  },
];

export const SDK_PACKAGES: ReadonlyArray<SdkPackage> = [
  {
    id: "react-native",
    nameKey: "reactNative",
    targetKey: "reactNative",
    icon: Smartphone,
    iconClass: "text-rv-accent-400",
    version: "0.9.3",
    publishedKey: "publishedDays",
    status: "stable",
    install: "pnpm add @rovenue/react-native",
    installLanguage: "bash",
    repoLabel: "github.com/rovenue/sdk-rn",
    docsKey: "rnDocs",
  },
  {
    id: "ios",
    nameKey: "ios",
    targetKey: "ios",
    icon: Apple,
    iconClass: "text-foreground",
    version: "0.9.3",
    publishedKey: "publishedDays",
    status: "stable",
    install: ".package(url: \"https://github.com/rovenue/rovenue-ios\", from: \"0.9.3\")",
    installLanguage: "swift",
    repoLabel: "github.com/rovenue/rovenue-ios",
    docsKey: "iosDocs",
  },
  {
    id: "android",
    nameKey: "android",
    targetKey: "android",
    icon: Smartphone,
    iconClass: "text-rv-success",
    version: "0.9.3",
    publishedKey: "publishedDays",
    status: "stable",
    install: "implementation(\"io.rovenue:rovenue-android:0.9.3\")",
    installLanguage: "kotlin",
    repoLabel: "github.com/rovenue/rovenue-android",
    docsKey: "androidDocs",
  },
  {
    id: "web",
    nameKey: "web",
    targetKey: "web",
    icon: Globe,
    iconClass: "text-rv-violet",
    version: "0.4.1",
    publishedKey: "publishedWeeks",
    status: "beta",
    install: "pnpm add @rovenue/web",
    installLanguage: "bash",
    repoLabel: "github.com/rovenue/rovenue-web",
    docsKey: "webDocs",
  },
  {
    id: "node",
    nameKey: "node",
    targetKey: "server",
    icon: Server,
    iconClass: "text-rv-warning",
    version: "1.2.0",
    publishedKey: "publishedDays",
    status: "stable",
    install: "pnpm add @rovenue/node",
    installLanguage: "bash",
    repoLabel: "github.com/rovenue/rovenue-node",
    docsKey: "nodeDocs",
  },
  {
    id: "go",
    nameKey: "go",
    targetKey: "server",
    icon: Cloud,
    iconClass: "text-rv-mute-600",
    version: "0.1.0",
    publishedKey: "publishedNew",
    status: "preview",
    install: "go get github.com/rovenue/rovenue-go",
    installLanguage: "bash",
    repoLabel: "github.com/rovenue/rovenue-go",
    docsKey: "goDocs",
  },
];

export const REST_ENDPOINTS: ReadonlyArray<RestEndpoint> = [
  {
    id: "subscribers-get",
    method: "GET",
    path: "/v1/subscribers/{appUserId}",
    summaryKey: "subscribersGet",
    scopeKey: "read",
  },
  {
    id: "subscribers-attrs",
    method: "POST",
    path: "/v1/subscribers/{appUserId}/attributes",
    summaryKey: "subscribersAttrs",
    scopeKey: "write",
  },
  {
    id: "purchase-receipts",
    method: "POST",
    path: "/v1/receipts",
    summaryKey: "receipts",
    scopeKey: "write",
  },
  {
    id: "credits-grant",
    method: "POST",
    path: "/v1/credits/grants",
    summaryKey: "creditsGrant",
    scopeKey: "write",
  },
  {
    id: "credits-balance",
    method: "GET",
    path: "/v1/credits/{appUserId}/balance",
    summaryKey: "creditsBalance",
    scopeKey: "read",
  },
  {
    id: "entitlements-get",
    method: "GET",
    path: "/v1/entitlements/{appUserId}",
    summaryKey: "entitlementsGet",
    scopeKey: "read",
  },
  {
    id: "experiments-assign",
    method: "POST",
    path: "/v1/experiments/{key}/assignments",
    summaryKey: "experimentsAssign",
    scopeKey: "write",
  },
  {
    id: "subscribers-delete",
    method: "DELETE",
    path: "/v1/subscribers/{appUserId}",
    summaryKey: "subscribersDelete",
    scopeKey: "admin",
  },
];

export const WEBHOOK_DELIVERIES: ReadonlyArray<WebhookDelivery> = [
  {
    id: "evt_5b41",
    status: "ok",
    eventKey: "subscriptionRenewed",
    latencyMs: 132,
    ageKey: "secondsAgo",
  },
  {
    id: "evt_5b40",
    status: "ok",
    eventKey: "trialStarted",
    latencyMs: 89,
    ageKey: "secondsAgoLong",
  },
  {
    id: "evt_5b3f",
    status: "retry",
    eventKey: "subscriptionExpired",
    latencyMs: 412,
    ageKey: "minutesAgo",
  },
  {
    id: "evt_5b3e",
    status: "ok",
    eventKey: "creditsGranted",
    latencyMs: 76,
    ageKey: "minutesAgoLong",
  },
  {
    id: "evt_5b3d",
    status: "failed",
    eventKey: "purchaseRefunded",
    latencyMs: 1842,
    ageKey: "hoursAgo",
  },
];

export const RESOURCES: ReadonlyArray<ResourceLink> = [
  {
    id: "docs",
    labelKey: "docs",
    descriptionKey: "docs",
    href: "https://docs.rovenue.io",
    icon: BookOpen,
  },
  {
    id: "openapi",
    labelKey: "openapi",
    descriptionKey: "openapi",
    href: "https://docs.rovenue.io/api",
    icon: FileCode2,
  },
  {
    id: "guides",
    labelKey: "guides",
    descriptionKey: "guides",
    href: "https://docs.rovenue.io/guides",
    icon: Compass,
  },
  {
    id: "github",
    labelKey: "github",
    descriptionKey: "github",
    href: "https://github.com/rovenue",
    icon: FolderGit2,
  },
  {
    id: "status",
    labelKey: "status",
    descriptionKey: "status",
    href: "https://status.rovenue.io",
    icon: Zap,
  },
  {
    id: "security",
    labelKey: "security",
    descriptionKey: "security",
    href: "https://docs.rovenue.io/security",
    icon: ShieldCheck,
  },
];

export const QUICKSTART_ICON = Terminal;
