import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { S3Client, CreateBucketCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import { env } from "../src/lib/env";

// =============================================================
// MinIO testcontainer helper (Task 8)
// =============================================================
//
// `env` (src/lib/env.ts) is parsed once at import — mutating
// `process.env` after that point is too late for `lib/asset-store.ts`'s
// lazily-built S3 client, which reads `env.ASSET_STORAGE_*` at call
// time. Mutate the shared (unfrozen) `env` object directly, mirroring
// the ClickHouse integration tests' convention
// (tests/analytics-clickhouse.integration.test.ts).
//
// `ASSET_PUBLIC_BASE_URL` is deliberately the bucket-path form
// (`http://host:port/bucket`), not a bare origin — that's what a real
// path-style MinIO deployment serves, and it's the exact shape that
// once broke `parseAssetUrl`'s key pattern (anchored to the whole
// pathname; fixed Task 3). A bare origin here would quietly stop
// exercising that base-path handling.

export const MINIO_TEST_BUCKET = "rovenue-test";
export const MINIO_TEST_ACCESS_KEY = "testkey";
export const MINIO_TEST_SECRET_KEY = "testsecret";

export async function startMinio(): Promise<StartedTestContainer> {
  const container = await new GenericContainer("minio/minio:latest")
    .withCommand(["server", "/data"])
    .withEnvironment({
      MINIO_ROOT_USER: MINIO_TEST_ACCESS_KEY,
      MINIO_ROOT_PASSWORD: MINIO_TEST_SECRET_KEY,
    })
    .withExposedPorts(9000)
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;

  const mEnv = env as {
    ASSET_STORAGE_ENDPOINT?: string;
    ASSET_STORAGE_REGION?: string;
    ASSET_STORAGE_BUCKET?: string;
    ASSET_STORAGE_ACCESS_KEY_ID?: string;
    ASSET_STORAGE_SECRET_ACCESS_KEY?: string;
    ASSET_PUBLIC_BASE_URL?: string;
  };
  mEnv.ASSET_STORAGE_ENDPOINT = endpoint;
  mEnv.ASSET_STORAGE_REGION = "us-east-1";
  mEnv.ASSET_STORAGE_BUCKET = MINIO_TEST_BUCKET;
  mEnv.ASSET_STORAGE_ACCESS_KEY_ID = MINIO_TEST_ACCESS_KEY;
  mEnv.ASSET_STORAGE_SECRET_ACCESS_KEY = MINIO_TEST_SECRET_KEY;
  mEnv.ASSET_PUBLIC_BASE_URL = `${endpoint}/${MINIO_TEST_BUCKET}`;

  // Also set process.env for any code path that reads it directly
  // rather than through the parsed `env` singleton.
  process.env.ASSET_STORAGE_ENDPOINT = mEnv.ASSET_STORAGE_ENDPOINT;
  process.env.ASSET_STORAGE_REGION = mEnv.ASSET_STORAGE_REGION;
  process.env.ASSET_STORAGE_BUCKET = mEnv.ASSET_STORAGE_BUCKET;
  process.env.ASSET_STORAGE_ACCESS_KEY_ID = mEnv.ASSET_STORAGE_ACCESS_KEY_ID;
  process.env.ASSET_STORAGE_SECRET_ACCESS_KEY = mEnv.ASSET_STORAGE_SECRET_ACCESS_KEY;
  process.env.ASSET_PUBLIC_BASE_URL = mEnv.ASSET_PUBLIC_BASE_URL;

  // Create the bucket before any test runs. A short-lived client of our
  // own — lib/asset-store.ts's own client is memoized lazily on first
  // use and must not be constructed before the env mutation above lands.
  const bootstrapClient = new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: MINIO_TEST_ACCESS_KEY,
      secretAccessKey: MINIO_TEST_SECRET_KEY,
    },
    forcePathStyle: true,
  });
  await bootstrapClient.send(new CreateBucketCommand({ Bucket: MINIO_TEST_BUCKET }));

  // MinIO buckets are private by default (anonymous GET -> 403). The real
  // deployment fronts the bucket with a CDN/public-read policy so
  // `publicUrl()` actually resolves for an end user; without this the
  // "serves the bytes back from its public URL" case would be testing
  // an unrealistic, always-403 setup rather than what production does.
  await bootstrapClient.send(
    new PutBucketPolicyCommand({
      Bucket: MINIO_TEST_BUCKET,
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: ["s3:GetObject"],
            Resource: [`arn:aws:s3:::${MINIO_TEST_BUCKET}/*`],
          },
        ],
      }),
    }),
  );
  bootstrapClient.destroy();

  return container;
}
