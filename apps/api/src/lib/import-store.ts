import type { Readable } from "node:stream";
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { IMPORT_STORAGE_PREFIX } from "@rovenue/shared";
import { env } from "./env";

// =============================================================
// ImportStore — the one place that knows the import bucket
// =============================================================
//
// Uploaded files here are end-user PII (a customer's RevenueCat/Adapty
// export). This is deliberately a SEPARATE bucket from
// `lib/asset-store.ts`'s paywall-asset CDN bucket, not the same bucket
// under a different prefix — `deploy/minio`'s `minio-init` grants
// anonymous `s3:GetObject` on `arn:aws:s3:::<asset bucket>/*`, i.e. the
// WHOLE bucket, not a prefix-scoped ARN. Reusing that bucket for import
// uploads would make every customer's PII export anonymously
// downloadable the instant it landed, regardless of what prefix this
// module put it under. A dedicated bucket is the only boundary that
// actually holds.
//
// This bucket carries NO anonymous policy at all — not even the
// `s3:GetObject`-only shape the asset bucket uses. It is reachable only
// with the S3 credentials below, the same lesson `deploy/minio/README.md`
// documents for the asset bucket taken one step further: `mc anonymous
// set download` grants `s3:ListBucket` alongside `s3:GetObject` on this
// MinIO release, so even a "read-only" public policy would let every
// PII export be enumerated. The only correct policy for this bucket is
// no policy.
//
// Credentials and endpoint are reused from the asset-store env vars
// (one MinIO instance / one R2 account can host multiple buckets); only
// `IMPORT_STORAGE_BUCKET` is a distinct name — see env.ts's comment.
// There is deliberately no `publicUrl`/`parseAssetUrl` pair here, unlike
// asset-store.ts: nothing about this bucket is ever meant to be reached
// by a public URL.

/** `{IMPORT_STORAGE_PREFIX}/{projectId}/{jobId}/{fileName}` — scoped by
 *  project and job so two uploads for the same project never collide,
 *  and a human can still recognise the original file name in the key. */
export function buildStorageKey(
  projectId: string,
  jobId: string,
  fileName: string,
): string {
  return `${IMPORT_STORAGE_PREFIX}/${projectId}/${jobId}/${fileName}`;
}

/** `{IMPORT_STORAGE_PREFIX}/{projectId}/{jobId}/report.ndjson` — the
 *  dry-run planner's report artefact for one job (services/import/plan.ts),
 *  keyed the same way as the uploaded source object (scoped by project and
 *  job) so the two never collide and a human can find both from the job id
 *  alone. Owned here, not in services/import/report.ts, so this module
 *  stays the single place that knows the shape of every key in this
 *  bucket.
 *
 *  The Phase-A WRITER (workers/import-runner.ts) does NOT use this key —
 *  see `buildReportPartStorageKey` below for why, and for the key it
 *  actually uses. */
export function buildReportStorageKey(projectId: string, jobId: string): string {
  return `${IMPORT_STORAGE_PREFIX}/${projectId}/${jobId}/report.ndjson`;
}

/** `{IMPORT_STORAGE_PREFIX}/{projectId}/{jobId}/report.part-{NNNN}.ndjson`
 *  — one immutable report object per `runImportJob` ATTEMPT that did real
 *  work (Task 8 fix round 1, FIX 5), numbered from 1.
 *
 *  The Phase-A writer used to share ONE overwritable key
 *  (`buildReportStorageKey`) across every attempt at a job, so a
 *  crash-and-resume permanently lost the per-row skip reasons
 *  (`invalidRow` / `unresolvedProduct` / `anchorless` / `androidNoToken`)
 *  from every earlier, already-checkpointed batch — the only place those
 *  reasons are recorded at all; nothing else in the database has them.
 *  Numbering parts instead means an attempt can never destroy a previous
 *  one's report. `import_jobs.reportPartCount` records how many parts
 *  exist; a reader (Task 10's download endpoint) enumerates
 *  `1..reportPartCount` through this same function, in order, to
 *  reconstruct the full report — see workers/import-runner.ts's
 *  `ensureReportWriter` for the writing side of this contract. */
export function buildReportPartStorageKey(
  projectId: string,
  jobId: string,
  partNumber: number,
): string {
  const padded = String(partNumber).padStart(4, "0");
  return `${IMPORT_STORAGE_PREFIX}/${projectId}/${jobId}/report.part-${padded}.ndjson`;
}

export function isStorageConfigured(): boolean {
  return Boolean(
    env.ASSET_STORAGE_ENDPOINT &&
      env.IMPORT_STORAGE_BUCKET &&
      env.ASSET_STORAGE_ACCESS_KEY_ID &&
      env.ASSET_STORAGE_SECRET_ACCESS_KEY,
  );
}

let client: S3Client | null = null;

function s3(): S3Client {
  if (!isStorageConfigured()) {
    throw new Error(
      "import storage is not configured — set ASSET_STORAGE_ENDPOINT, IMPORT_STORAGE_BUCKET, ASSET_STORAGE_ACCESS_KEY_ID and ASSET_STORAGE_SECRET_ACCESS_KEY",
    );
  }
  if (!client) {
    client = new S3Client({
      endpoint: env.ASSET_STORAGE_ENDPOINT,
      region: env.ASSET_STORAGE_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: env.ASSET_STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: env.ASSET_STORAGE_SECRET_ACCESS_KEY!,
      },
      // MinIO serves path-style; R2 and S3 accept it too.
      forcePathStyle: true,
    });
  }
  return client;
}

/** `Upload` rather than `PutObjectCommand`, same reason as asset-store.ts:
 *  it accepts a stream and drives S3 multipart itself, which is what
 *  keeps a large CSV export from ever being fully resident. */
export async function putObject(
  key: string,
  body: Readable | Buffer,
  contentType: string,
): Promise<void> {
  await new Upload({
    client: s3(),
    params: {
      Bucket: env.IMPORT_STORAGE_BUCKET!,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
  }).done();
}

/**
 * Streams an object back out as a Readable — used by the dry-run planner
 * (Task 6) to read the uploaded CSV back through the same streaming
 * parser (`parseCsvStream`) it was validated with at upload time, and by
 * the writer (Task 7) for the same reason. `res.Body` is typed loosely by
 * the SDK (`StreamingBlobPayloadOutputTypes`, a union covering browser and
 * Node runtimes); this module only ever runs under Node, where it is
 * always a `Readable`.
 */
export async function getObject(key: string): Promise<Readable> {
  const res = await s3().send(
    new GetObjectCommand({ Bucket: env.IMPORT_STORAGE_BUCKET!, Key: key }),
  );
  if (!res.Body) {
    throw new Error(`import-store: getObject returned an empty body for key ${key}`);
  }
  return res.Body as unknown as Readable;
}

/** Used by the retention sweep once a job reaches a terminal state (see
 *  `IMPORT_FILE_RETENTION_DAYS` — the sweeper itself is a later task; this
 *  is the primitive it will call). */
export async function deleteObject(key: string): Promise<void> {
  await s3().send(
    new DeleteObjectCommand({ Bucket: env.IMPORT_STORAGE_BUCKET!, Key: key }),
  );
}

/**
 * AWS SDK v3 names a missing key's rejection differently per operation —
 * `HeadObjectCommand` throws `NotFound`, `GetObjectCommand` throws the
 * modeled `NoSuchKey` — so both names are treated as "the object is
 * gone", never just one. Exported so Task 10's report route can tell
 * "retention already deleted this" (expected, not a bug) apart from a
 * genuine failure (auth, network, a broken bucket) when a `getObject`
 * call fails mid-stream, the same way `objectExists` below already does
 * for its own `HeadObjectCommand` call.
 */
export function isObjectNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err.name === "NotFound" || err.name === "NoSuchKey");
}

/**
 * Cheap existence probe (HEAD, not GET) — used by Task 10's report
 * download route to tell "retention already deleted this" apart from a
 * genuine bug BEFORE it commits to a streamed 200 response (once
 * `c.body()` starts emitting bytes, the status code can no longer
 * change). Mirrors `asset-store.ts`'s `getObjectLastModified`.
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(
      new HeadObjectCommand({ Bucket: env.IMPORT_STORAGE_BUCKET!, Key: key }),
    );
    return true;
  } catch (err) {
    if (isObjectNotFoundError(err)) return false;
    throw err;
  }
}
