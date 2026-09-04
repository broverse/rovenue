#!/usr/bin/env tsx
/**
 * Verifies that the paywall asset origin actually serves the response
 * headers its configuration promises.
 *
 * The configurations already exist — deploy/cloudflare/asset-headers
 * (Transform Rule) and deploy/caddy/conf.d/assets.caddy.example — but
 * both are applied by hand and BOTH FAIL SILENTLY. A Transform Rule
 * scoped to the wrong hostname matches nothing; the Caddy drop-in does
 * nothing until an operator copies it into place. Nobody finds out.
 *
 * Usage:
 *   ASSET_PUBLIC_BASE_URL=https://cdn.rovenue.app tsx verify-asset-headers.ts <projectId>/<assetId>.webp
 *   ASSET_PUBLIC_BASE_URL=... ASSET_VERIFY_KEY=<key> tsx verify-asset-headers.ts
 */

export const REQUIRED_HEADERS = {
  contentTypeOptions: "x-content-type-options",
  etag: "etag",
  cacheControl: "cache-control",
  contentType: "content-type",
} as const;

export const EXPECTED_NOSNIFF = "nosniff";
export const EXPECTED_CACHE_DIRECTIVE = "immutable";
/** A W/ prefix means a weak validator: conditional requests degrade. */
export const WEAK_ETAG_PREFIX = "W/";

export const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".json": "application/json",
};

/** A `PUT` is only "refused" if the status falls in this 4xx range —
 * inclusive lower bound, exclusive upper bound. Anything else (2xx/3xx
 * meaning the write went through, or 5xx meaning the origin errored
 * rather than intentionally refusing) does not satisfy the guarantee. */
const REFUSAL_STATUS_MIN = 400;
const REFUSAL_STATUS_MAX_EXCLUSIVE = 500;

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

export interface CheckFailure {
  check: string;
  detail: string;
}

export interface VerifyResult {
  url: string;
  failures: CheckFailure[];
  /** Header values observed on the HEAD response, when it was reachable. */
  headers?: Record<string, string>;
}

/** Joins a base URL and a key defensively: exactly one slash between them,
 * regardless of whether the base already ends in one or the key starts
 * with one. `ASSET_PUBLIC_BASE_URL` may or may not include a trailing
 * bucket path segment (MinIO does, R2 doesn't), so a naive concatenation
 * can silently produce a 404 that reads like a missing header. */
function joinUrl(baseUrl: string, key: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedKey = key.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedKey}`;
}

function extensionOf(key: string): string {
  const match = /\.[a-zA-Z0-9]+$/.exec(key);
  return match ? match[0].toLowerCase() : "";
}

export async function verifyAssetHeaders(
  baseUrl: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const url = joinUrl(baseUrl, key);
  const failures: CheckFailure[] = [];

  // Check 1: HEAD returns 200.
  let headResponse: Response;
  try {
    headResponse = await fetchImpl(url, { method: "HEAD" });
  } catch (err) {
    failures.push({
      check: "head-status",
      detail: `request failed: ${(err as Error).message}`,
    });
    return { url, failures };
  }

  if (headResponse.status !== 200) {
    failures.push({
      check: "head-status",
      detail: `expected 200, got ${headResponse.status}`,
    });
    // Headers on a non-200 response don't mean much for the remaining
    // checks, but we still record what came back for diagnostics.
    return {
      url,
      failures,
      headers: Object.fromEntries(headResponse.headers.entries()),
    };
  }

  const observedHeaders: Record<string, string> = {};
  for (const name of Object.values(REQUIRED_HEADERS)) {
    const value = headResponse.headers.get(name);
    if (value !== null) observedHeaders[name] = value;
  }

  // Check 2: x-content-type-options is exactly nosniff.
  const contentTypeOptions = headResponse.headers.get(
    REQUIRED_HEADERS.contentTypeOptions,
  );
  if (contentTypeOptions !== EXPECTED_NOSNIFF) {
    failures.push({
      check: "x-content-type-options",
      detail: `expected "${EXPECTED_NOSNIFF}", got ${
        contentTypeOptions === null ? "(missing)" : `"${contentTypeOptions}"`
      }`,
    });
  }

  // Check 3: etag is present and strong (not W/-prefixed).
  const etag = headResponse.headers.get(REQUIRED_HEADERS.etag);
  if (etag === null) {
    failures.push({ check: "etag", detail: "header is missing" });
  } else if (etag.startsWith(WEAK_ETAG_PREFIX)) {
    failures.push({
      check: "etag",
      detail: `weak validator "${etag}" (starts with "${WEAK_ETAG_PREFIX}")`,
    });
  }

  // Check 4: cache-control contains immutable.
  const cacheControl = headResponse.headers.get(REQUIRED_HEADERS.cacheControl);
  if (cacheControl === null || !cacheControl.includes(EXPECTED_CACHE_DIRECTIVE)) {
    failures.push({
      check: "cache-control",
      detail: `expected to contain "${EXPECTED_CACHE_DIRECTIVE}", got ${
        cacheControl === null ? "(missing)" : `"${cacheControl}"`
      }`,
    });
  }

  // Check 5: content-type matches the key's extension.
  const contentType = headResponse.headers.get(REQUIRED_HEADERS.contentType);
  const extension = extensionOf(key);
  const expectedContentType = EXTENSION_CONTENT_TYPES[extension];
  if (expectedContentType === undefined) {
    failures.push({
      check: "content-type",
      detail: `key "${key}" has an unrecognized extension "${extension || "(none)"}" — cannot verify`,
    });
  } else if (contentType === null || !contentType.startsWith(expectedContentType)) {
    failures.push({
      check: "content-type",
      detail: `expected "${expectedContentType}", got ${
        contentType === null ? "(missing)" : `"${contentType}"`
      }`,
    });
  }

  // Check 6: an anonymous PUT is refused (any 4xx or 405).
  try {
    const putResponse = await fetchImpl(url, {
      method: "PUT",
      body: "verify-asset-headers anonymous write probe",
    });
    if (
      putResponse.status < REFUSAL_STATUS_MIN ||
      putResponse.status >= REFUSAL_STATUS_MAX_EXCLUSIVE
    ) {
      failures.push({
        check: "put-refused",
        detail: `expected a 4xx refusal, got ${putResponse.status} — anonymous write reached the origin`,
      });
    }
  } catch (err) {
    // A network-level rejection (e.g. connection reset) is NOT proof of a
    // refusal — it's simply unverifiable, and this fails closed rather
    // than silently treating "the request never completed" as a pass.
    failures.push({
      check: "put-refused",
      detail: `PUT request errored rather than returning a status (treating as unverifiable): ${(err as Error).message}`,
    });
  }

  return { url, failures, headers: observedHeaders };
}

async function main(): Promise<void> {
  const baseUrl = process.env.ASSET_PUBLIC_BASE_URL;
  if (!baseUrl) {
    console.error("ASSET_PUBLIC_BASE_URL is not set");
    process.exit(EXIT_FAILURE);
  }

  const key = process.argv[2] ?? process.env.ASSET_VERIFY_KEY;
  if (!key) {
    console.error(
      "no key given — pass one as argv[2] or set ASSET_VERIFY_KEY",
    );
    process.exit(EXIT_FAILURE);
  }

  const result = await verifyAssetHeaders(baseUrl as string, key as string);

  if (result.failures.length > 0) {
    console.error(`FAIL ${result.url}`);
    for (const failure of result.failures) {
      console.error(`  [${failure.check}] ${failure.detail}`);
    }
    process.exit(EXIT_FAILURE);
  }

  console.log(`PASS ${result.url}`);
  for (const name of Object.values(REQUIRED_HEADERS)) {
    console.log(`  ${name}: ${result.headers?.[name] ?? "(missing)"}`);
  }
  process.exit(EXIT_SUCCESS);
}

const isMainModule = process.argv[1]?.endsWith("verify-asset-headers.ts");
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(EXIT_FAILURE);
  });
}
