import { Readable } from "node:stream";
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  ASSET_CACHE_MAX_AGE_SECONDS,
  ASSET_FILE_EXTENSIONS,
  type AssetKind,
} from "@rovenue/shared";
import { env } from "./env";

// =============================================================
// AssetStore — the one place that knows S3, and the one place that
// knows the public URL shape
// =============================================================
//
// MinIO (self-host), R2 and S3 (cloud) all speak the S3 protocol, so
// there is one implementation and only the endpoint and credentials
// differ. Routes never import the AWS SDK.
//
// `publicUrl` and `parseAssetUrl` live together deliberately: they are
// inverses, and the lesson from `buildFontFaceFileUrl`
// (routes/v1/fonts.ts:36) is that a producer and a parser kept apart
// drift apart silently. The usage index (design spec §7) depends on
// the parse still matching what the producer emits, months later.
//
// The URL a device fetches is frozen into the bundled fallback-export
// file, so this shape is effectively permanent once assets ship.

/** `{projectId}/{assetId}.{ext}` — no content hash, because an asset row
 *  is never overwritten (design spec §4.1), so the id alone already
 *  guarantees this key's bytes never change. */
export function buildStorageKey(
  projectId: string,
  assetId: string,
  kind: AssetKind,
): string {
  return `${projectId}/${assetId}.${ASSET_FILE_EXTENSIONS[kind]}`;
}

/** Trailing-slash hazard, same as `buildFontFaceFileUrl`'s: a base of
 *  "https://cdn/" would otherwise produce "https://cdn//prj_…". */
export function publicUrl(storageKey: string): string {
  const base = (env.ASSET_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/${storageKey}`;
}

const KEY_PATTERN = /^([^/]+)\/([^/.]+)\.(webp|mp4|json)$/;

export function parseAssetUrl(
  url: string,
): { projectId: string; assetId: string } | null {
  const base = env.ASSET_PUBLIC_BASE_URL;
  if (!base) return null;
  let parsed: URL;
  let baseParsed: URL;
  try {
    parsed = new URL(url);
    baseParsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.origin !== baseParsed.origin) return null;

  // The base URL may carry a path prefix, and in one supported
  // deployment it always does: path-style MinIO puts the bucket in the
  // path (`http://host:9000/rovenue-assets`). Anchoring the pattern to
  // the whole pathname would make every parse return null there — and
  // a null here does not look like a failure, it looks like "no paywall
  // uses this asset", which is the answer that gets an in-use asset
  // deleted. So strip the base's own path before matching.
  const basePath = baseParsed.pathname.replace(/\/+$/, "");
  if (basePath && !parsed.pathname.startsWith(`${basePath}/`)) return null;
  const keyPath = parsed.pathname.slice(basePath.length).replace(/^\/+/, "");

  const match = KEY_PATTERN.exec(keyPath);
  if (!match) return null;
  return { projectId: match[1]!, assetId: match[2]! };
}

export function isStorageConfigured(): boolean {
  return Boolean(
    env.ASSET_STORAGE_ENDPOINT &&
      env.ASSET_STORAGE_BUCKET &&
      env.ASSET_STORAGE_ACCESS_KEY_ID &&
      env.ASSET_STORAGE_SECRET_ACCESS_KEY &&
      env.ASSET_PUBLIC_BASE_URL,
  );
}

let client: S3Client | null = null;

function s3(): S3Client {
  if (!isStorageConfigured()) {
    // Without this guard, a caller who skips `isStorageConfigured()`
    // hits a non-null assertion below and gets an opaque SDK error
    // (or a client silently pointed at nothing) instead of a message
    // that names the actual problem.
    throw new Error(
      "asset storage is not configured — set ASSET_STORAGE_ENDPOINT, ASSET_STORAGE_BUCKET, ASSET_STORAGE_ACCESS_KEY_ID, ASSET_STORAGE_SECRET_ACCESS_KEY and ASSET_PUBLIC_BASE_URL",
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

/** `Upload` rather than `PutObjectCommand`: it accepts a stream and
 *  drives S3 multipart itself, which is what keeps a 50 MB video from
 *  ever being fully resident (design spec §3.1). */
export async function putObject(
  key: string,
  body: Readable | Buffer,
  contentType: string,
): Promise<void> {
  await new Upload({
    client: s3(),
    params: {
      Bucket: env.ASSET_STORAGE_BUCKET!,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: `public, max-age=${ASSET_CACHE_MAX_AGE_SECONDS}, immutable`,
    },
  }).done();
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(
    new DeleteObjectCommand({ Bucket: env.ASSET_STORAGE_BUCKET!, Key: key }),
  );
}

/** Used only by the orphan sweeper. An orphan by definition may have no
 *  `paywall_assets` row to read a timestamp from, so the object's own
 *  `LastModified` is the only place its age can come from. Returns null
 *  if the object no longer exists (e.g. it raced with a concurrent
 *  delete between `listAllKeys()` and this call) — the sweeper treats
 *  that as "nothing to reclaim" rather than an error. */
export async function getObjectLastModified(key: string): Promise<Date | null> {
  try {
    const res = await s3().send(
      new HeadObjectCommand({ Bucket: env.ASSET_STORAGE_BUCKET!, Key: key }),
    );
    return res.LastModified ?? null;
  } catch (err) {
    if (err instanceof Error && err.name === "NotFound") return null;
    throw err;
  }
}

/** Used only by the orphan sweeper. Paginates — a project with many
 *  assets will exceed the 1000-key page size. */
export async function listAllKeys(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({
        Bucket: env.ASSET_STORAGE_BUCKET!,
        ContinuationToken: token,
      }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}
