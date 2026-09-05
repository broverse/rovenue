import {
  Apple,
  BookOpen,
  Compass,
  FileCode2,
  FolderGit2,
  ShieldCheck,
  Smartphone,
  Zap,
} from "lucide-react";
import type {
  PlatformDescriptor,
  ResourceLink,
  RestEndpoint,
  SdkPackage,
} from "./types";

// Base URL of the public REST surface. Shown in the quickstart / endpoint
// reference snippets so operators can copy a working request verbatim.
export const API_BASE_URL = "https://api.rovenue.io/v1";

// External destinations for the page's reference links. Centralised so the
// "Docs", "API reference", and "Changelog" buttons all resolve to real URLs
// instead of `href="#"`.
export const DOCS_URL = "https://docs.rovenue.io";
export const API_REFERENCE_URL = "https://docs.rovenue.io/api";

// The monorepo every SDK in this list is built from, and the generated SwiftPM
// distribution repository external Swift consumers actually resolve (see
// packages/sdk-swift/scripts/generate-swift-dist.sh — SPM cannot depend on the
// monorepo, whose manifest uses a local binaryTarget path).
export const REPO_URL = "https://github.com/broverse/rovenue";
export const SWIFT_PACKAGE_URL = "https://github.com/broverse/rovenue-swift.git";
export const CHANGELOG_URL = `${REPO_URL}/releases`;

// One version for every façade: packages/sdk-swift/release.config.json,
// Cargo.toml, sdk-rn/package.json, sdk-kotlin/build.gradle.kts and the Flutter
// pubspecs are locked to a single number by
// packages/sdk-swift/Tests/config-version-parity.sh and
// packages/sdk-rn/src/__tests__/version.test.ts. Bump this alongside them.
export const SDK_VERSION = "0.16.0";

// Published package coordinates. These are copy-and-run strings shown to
// operators, so they must match what is actually published, not an older name.
export const RN_PACKAGE_NAME = "@rovenue/react-native-sdk";
export const ANDROID_COORDINATES = `dev.rovenue:sdk:${SDK_VERSION}`;
export const SWIFT_PACKAGE_INSTALL = `.package(url: "${SWIFT_PACKAGE_URL}", from: "${SDK_VERSION}")`;

// Placeholder token embedded in the init snippets below. QuickstartCard
// swaps this for the project's real publishable key at render time when one
// exists; the secret-key placeholder (`rvn_sk_live_…`) is never substituted
// because the server only ever reveals a secret once, at creation time.
export const PUBLISHABLE_KEY_PLACEHOLDER = "rvn_pk_live_…";

export const PLATFORMS: ReadonlyArray<PlatformDescriptor> = [
  {
    id: "react-native",
    labelKey: "reactNative",
    language: "bash",
    installCommand: `pnpm add ${RN_PACKAGE_NAME}`,
    installFilename: "terminal",
    initSnippet: `import { Rovenue } from "${RN_PACKAGE_NAME}";

await Rovenue.configure({
  publicKey: "${PUBLISHABLE_KEY_PLACEHOLDER}",
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
    installCommand: SWIFT_PACKAGE_INSTALL,
    initSnippet: `import Rovenue

Rovenue.configure(
  publicKey: "${PUBLISHABLE_KEY_PLACEHOLDER}",
  appUserId: user.id
)

let offerings = try await Rovenue.shared.getOfferings()`,
    installFilename: "Package.swift",
    initFilename: "AppDelegate.swift",
    initLanguage: "swift",
  },
  {
    id: "android",
    labelKey: "android",
    language: "kotlin",
    installCommand: `implementation("${ANDROID_COORDINATES}")`,
    initSnippet: `import dev.rovenue.sdk.Rovenue

Rovenue.configure(
  publicKey = "${PUBLISHABLE_KEY_PLACEHOLDER}",
  appUserId = user.id,
)

val offerings = Rovenue.shared.getOfferings()`,
    installFilename: "build.gradle.kts",
    initFilename: "Application.kt",
    initLanguage: "kotlin",
  },
  {
    id: "rest",
    labelKey: "rest",
    language: "bash",
    installCommand: `curl ${API_BASE_URL}/health \\
  -H "Authorization: Bearer rvn_sk_live_…"`,
    installFilename: "terminal",
    initSnippet: `curl ${API_BASE_URL}/me \\
  -H "Authorization: Bearer rvn_sk_live_…" \\
  -H "Rovenue-Version: 2026-04-01"`,
    initFilename: "terminal",
    initLanguage: "bash",
  },
];

// The clients that actually exist in this monorepo (Rust core + native
// façades). All of them ship at SDK_VERSION — the version parity checks make a
// per-façade number impossible. node / go / web SDKs don't exist yet, so
// they're intentionally absent rather than shown as fabricated releases.
export const SDK_PACKAGES: ReadonlyArray<SdkPackage> = [
  {
    id: "react-native",
    nameKey: "reactNative",
    targetKey: "reactNative",
    icon: Smartphone,
    iconClass: "text-rv-accent-400",
    version: SDK_VERSION,
    status: "stable",
    install: `pnpm add ${RN_PACKAGE_NAME}`,
    installLanguage: "bash",
    repoLabel: "github.com/broverse/rovenue",
    docsKey: "rnDocs",
  },
  {
    id: "ios",
    nameKey: "ios",
    targetKey: "ios",
    icon: Apple,
    iconClass: "text-foreground",
    version: SDK_VERSION,
    status: "stable",
    install: SWIFT_PACKAGE_INSTALL,
    installLanguage: "swift",
    repoLabel: "github.com/broverse/rovenue-swift",
    docsKey: "iosDocs",
  },
  {
    id: "android",
    nameKey: "android",
    targetKey: "android",
    icon: Smartphone,
    iconClass: "text-rv-success",
    version: SDK_VERSION,
    status: "stable",
    install: `implementation("${ANDROID_COORDINATES}")`,
    installLanguage: "kotlin",
    repoLabel: "github.com/broverse/rovenue",
    docsKey: "androidDocs",
  },
];

// Curated public REST surface. Every entry maps to a real handler under
// apps/api/src/routes/v1 — verified against the mounted route tree, not a
// wishlist.
export const REST_ENDPOINTS: ReadonlyArray<RestEndpoint> = [
  {
    id: "me-get",
    method: "GET",
    path: "/v1/me",
    summaryKey: "meGet",
    scopeKey: "read",
  },
  {
    id: "me-entitlements",
    method: "GET",
    path: "/v1/me/entitlements",
    summaryKey: "meEntitlements",
    scopeKey: "read",
  },
  {
    id: "me-credits",
    method: "GET",
    path: "/v1/me/credits",
    summaryKey: "meCredits",
    scopeKey: "read",
  },
  {
    id: "offerings",
    method: "GET",
    path: "/v1/offerings",
    summaryKey: "offerings",
    scopeKey: "read",
  },
  {
    id: "receipts-apple",
    method: "POST",
    path: "/v1/receipts/apple",
    summaryKey: "receiptsApple",
    scopeKey: "write",
  },
  {
    id: "receipts-google",
    method: "POST",
    path: "/v1/receipts/google",
    summaryKey: "receiptsGoogle",
    scopeKey: "write",
  },
  {
    id: "subscribers-attrs",
    method: "POST",
    path: "/v1/subscribers/{appUserId}/attributes",
    summaryKey: "subscribersAttrs",
    scopeKey: "write",
  },
  {
    id: "credits-add",
    method: "POST",
    path: "/v1/subscribers/{appUserId}/credits/add",
    summaryKey: "creditsAdd",
    scopeKey: "write",
  },
  {
    id: "experiments-track",
    method: "POST",
    path: "/v1/experiments/track",
    summaryKey: "experimentsTrack",
    scopeKey: "write",
  },
  {
    id: "subscribers-transfer",
    method: "POST",
    path: "/v1/subscribers/transfer",
    summaryKey: "subscribersTransfer",
    scopeKey: "admin",
  },
];

export const RESOURCES: ReadonlyArray<ResourceLink> = [
  {
    id: "docs",
    labelKey: "docs",
    descriptionKey: "docs",
    href: DOCS_URL,
    icon: BookOpen,
  },
  {
    id: "openapi",
    labelKey: "openapi",
    descriptionKey: "openapi",
    href: API_REFERENCE_URL,
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
    href: REPO_URL,
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
