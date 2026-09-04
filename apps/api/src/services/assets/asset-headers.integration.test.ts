// =============================================================
// verifyAssetHeaders, proved against a real object store
// =============================================================
//
// `scripts/verify-asset-headers.ts` has so far only been driven by a mocked
// `fetch` (see its own unit test). That proves the TypeScript composed the
// checks it meant to; nothing proves those checks behave against a real
// origin serving a real object — the same "mocked forever" gap the metrics
// schema-contract suite (schema-contract.integration.test.ts) exists to
// close for ClickHouse. This file is that suite's counterpart for the
// paywall asset origin.
//
// The bucket policy below is copied by hand from docker-compose.yml's
// `minio-init` service, not generated with `mc anonymous set download` —
// that canned policy also grants `s3:ListBucket` (+ `s3:GetBucketLocation`),
// which would make the whole bucket anonymously enumerable. An unguessable
// cuid2 key is the entire security boundary (design spec §6), and that
// boundary evaporates the moment the bucket can be listed instead of
// guessed. So this test asserts BOTH directions against the real container:
// the object is anonymously readable (happy path, zero failures) AND the
// bucket is NOT anonymously listable, AND an anonymous write is refused.
//
// The uploaded object is JSON (Lottie's content type) with the exact
// Content-Type and Cache-Control `AssetStore.putObject` sets at upload time
// (apps/api/src/lib/asset-store.ts) — `application/json` is the one
// accepted asset type a browser could be talked into sniffing as something
// else, which is the whole reason `nosniff` is required at all.
//
// NOT parallel-safe in the sense that it starts its own container, but it
// binds no fixed host port (unlike the Kafka-advertised-address suites) —
// testcontainers assigns an ephemeral one, so no host-port-allocations
// registry entry is needed.

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  S3Client,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { ASSET_CACHE_MAX_AGE_SECONDS } from "@rovenue/shared";
import { verifyAssetHeaders } from "../../../../../scripts/verify-asset-headers";

// Same tag docker-compose.yml pins for the `minio` service — keeping the
// version identical means "it worked in this test" says something about
// what operators actually run.
const MINIO_IMAGE = "minio/minio:RELEASE.2025-04-08T15-41-24Z";
const MINIO_S3_PORT = 9000;
const MINIO_ROOT_USER = "rovenue-assets-test";
const MINIO_ROOT_PASSWORD = "rovenue-assets-test-secret";

const BUCKET = "rovenue-assets-test";
const RUN_ID = Date.now();
const PROJECT_ID = `prj_asset_headers_${RUN_ID}`;
const ASSET_ID = `ast_asset_headers_${RUN_ID}`;
/** Lottie is the case that matters: application/json is the one accepted
 *  asset type a browser could be talked into sniffing as something else. */
const ASSET_KEY = `${PROJECT_ID}/${ASSET_ID}.json`;
const WRONG_KEY = `${PROJECT_ID}/${ASSET_ID}-does-not-exist.json`;

const OBJECT_CONTENT_TYPE = "application/json";
/** Exactly what AssetStore.putObject sets (apps/api/src/lib/asset-store.ts):
 *  `public, max-age=${ASSET_CACHE_MAX_AGE_SECONDS}, immutable`. */
const OBJECT_CACHE_CONTROL = `public, max-age=${ASSET_CACHE_MAX_AGE_SECONDS}, immutable`;
const OBJECT_BODY = JSON.stringify({ v: 1, layers: [] });

/** Hand-authored s3:GetObject-ONLY policy — the exact JSON shape
 *  docker-compose.yml's `minio-init` service writes for the real asset
 *  bucket. Deliberately NOT `mc anonymous set download`: that canned policy
 *  also grants `s3:ListBucket` on this MinIO release, which is exactly the
 *  enumeration this bucket must not allow. */
function anonymousGetObjectOnlyPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

let minio: StartedTestContainer;
let baseUrl: string;

beforeAll(async () => {
  minio = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({
      MINIO_ROOT_USER,
      MINIO_ROOT_PASSWORD,
    })
    .withCommand(["server", "/data", "--console-address", ":9090"])
    .withExposedPorts(MINIO_S3_PORT)
    .withWaitStrategy(
      Wait.forHttp("/minio/health/live", MINIO_S3_PORT).forStatusCode(200),
    )
    .withStartupTimeout(60_000)
    .start();

  const host = minio.getHost();
  const mappedPort = minio.getMappedPort(MINIO_S3_PORT);
  const endpoint = `http://${host}:${mappedPort}`;

  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: MINIO_ROOT_USER,
      secretAccessKey: MINIO_ROOT_PASSWORD,
    },
    forcePathStyle: true,
  });

  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: BUCKET,
      Policy: anonymousGetObjectOnlyPolicy(BUCKET),
    }),
  );
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: ASSET_KEY,
      Body: OBJECT_BODY,
      ContentType: OBJECT_CONTENT_TYPE,
      CacheControl: OBJECT_CACHE_CONTROL,
    }),
  );
  client.destroy();

  // Path-style: the bucket is part of the base URL, same as production
  // (see assets.caddy.example's ASSET_PUBLIC_BASE_URL comment).
  baseUrl = `${endpoint}/${BUCKET}`;
}, 120_000);

afterAll(async () => {
  await minio?.stop();
});

describe("verifyAssetHeaders against a real MinIO", () => {
  it("reports zero failures for a real object with real headers", async () => {
    const result = await verifyAssetHeaders(baseUrl, ASSET_KEY);

    expect(result.failures).toEqual([]);
    // Sanity: the checks actually ran and saw something, rather than
    // short-circuiting on an unreachable origin.
    expect(result.headers?.["content-type"]).toContain(OBJECT_CONTENT_TYPE);
    expect(result.headers?.["cache-control"]).toBe(OBJECT_CACHE_CONTROL);
  });

  it("names the non-200 for a key that does not exist", async () => {
    const result = await verifyAssetHeaders(baseUrl, WRONG_KEY);

    expect(result.failures).toContainEqual(
      expect.objectContaining({
        check: "head-status",
        detail: expect.stringContaining("404"),
      }),
    );
  });

  it("does not allow the bucket to be anonymously listed", async () => {
    // ListObjectsV2 is a GET on the bucket root with a list-type query
    // param — the exact request `mc anonymous set download` would have
    // permitted via the `s3:ListBucket` grant this policy withholds.
    const response = await fetch(`${baseUrl}?list-type=2`);

    expect(response.status).not.toBe(200);
    expect(response.status).toBe(403);
  });

  it("refuses an anonymous PUT against a real object key", async () => {
    const response = await fetch(`${baseUrl}/${ASSET_KEY}`, {
      method: "PUT",
      body: "anonymous write probe — must be refused",
    });

    // This is the real-infra half of verifyAssetHeaders's check 6: if this
    // ever came back 2xx, the bucket policy above would have failed open,
    // and the happy-path assertion above (zero failures) would catch it —
    // check 6 only passes silently when the PUT genuinely came back 4xx.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
