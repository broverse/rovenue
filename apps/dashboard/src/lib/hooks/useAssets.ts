import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssetKind, ImageSourceFormat } from "@rovenue/shared";
import { API_BASE_URL, ApiError, api } from "../api";

// =============================================================
// Dashboard: project paywall assets (asset CDN, Task 11)
// =============================================================
//
// Mirrors the shape of useFonts.ts's list/delete hooks — a plain
// `api()` round-trip through the `{ data } / { error }` envelope. As
// with fonts' upload, this file's upload mutation is the one genuinely
// new shape, but for a different reason than fonts' multipart-vs-json
// content-type collision: the upload here is a RAW body (the server
// route, apps/api/src/routes/dashboard/assets.ts, deliberately never
// buffers into `FormData`), so `api()`'s content-type handling isn't
// the obstacle. The obstacle is that `fetch` cannot report REQUEST
// (upload) progress at all — only response/download progress via a
// body reader. A 50 MB video on a slow uplink is a minutes-long
// operation; with no progress signal the dashboard can only show an
// indeterminate spinner, which reads as a hang long before the upload
// actually finishes and invites the author to kill and retry it,
// wasting both the transfer and the quota reservation it already
// holds server-side. `XMLHttpRequest.upload.onprogress` is the only
// standard way to get real, determinate upload progress, so the
// upload mutation bypasses `api()`/`fetch` entirely and drives an XHR
// by hand — same "bypass the shared helper for this one transport"
// pattern as fonts.ts, different helper it's bypassing.

const base = (projectId: string) => `/dashboard/projects/${projectId}/assets`;

const listKey = (projectId: string) => ["assets", projectId] as const;
const usageKey = (projectId: string, assetId: string) =>
  ["assets", projectId, assetId, "usage"] as const;

/**
 * The upload endpoint's `toDto()` (apps/api/src/routes/dashboard/assets.ts)
 * spreads every `paywall_assets` column except `storageKey`, and adds the
 * resolved public `url` in its place — the dashboard never constructs a
 * storage URL itself.
 */
export interface Asset {
  id: string;
  projectId: string;
  kind: AssetKind;
  name: string;
  contentHash: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  sourceFormat: ImageSourceFormat | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  policyVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  url: string;
}

export interface StorageUsage {
  usedBytes: number;
  /** null means unlimited (HOST_MODE=self, or an enterprise tier). */
  limitBytes: number | null;
}

export interface AssetsResponse {
  assets: Asset[];
  usage: StorageUsage;
}

export interface PublishedPaywallRef {
  id: string;
  name: string;
}

/**
 * A project's live (non-deleted) assets plus its storage usage against
 * the tier limit. Deliberately fetched together — the same GET the
 * server exposes — so the usage figure the "storage used" bar shows is
 * never one request stale relative to the list it sits above.
 */
export function useAssets(projectId: string | undefined) {
  return useQuery({
    queryKey: listKey(projectId ?? ""),
    enabled: Boolean(projectId),
    queryFn: () => api<AssetsResponse>(base(projectId!)),
  });
}

/**
 * Which PUBLISHED paywalls currently reference this asset. This is the
 * honest boundary the server route documents (`listPublishedUsage`,
 * packages/db/src/drizzle/repositories/assets.ts): it joins on a
 * paywall's CURRENT `publishedVersionId`, not every version — or every
 * draft — that ever referenced the asset. An asset referenced only by a
 * draft returns an EMPTY list here, which is correct given the query
 * but dangerous if the caller renders it as "nothing uses this asset."
 * Query is disabled until an asset id is actually being considered for
 * deletion — this isn't prefetched for every row in the library.
 */
export function useAssetUsage(projectId: string | undefined, assetId: string | null) {
  return useQuery({
    queryKey: usageKey(projectId ?? "", assetId ?? ""),
    enabled: Boolean(projectId && assetId),
    queryFn: () =>
      api<{ publishedPaywalls: PublishedPaywallRef[] }>(
        `${base(projectId!)}/${assetId}/usage`,
      ),
  });
}

export interface UploadAssetInput {
  kind: AssetKind;
  /** Author-supplied display name; validated server-side against
   *  `isValidAssetName` (@rovenue/shared). */
  name: string;
  file: File;
  /** Fired repeatedly during the upload with a 0-100 integer — see the
   *  module comment on why this is XHR-driven rather than routed
   *  through `api()`. */
  onProgress?: (percent: number) => void;
}

interface UploadEnvelope {
  data?: Asset;
  error?: { code: string; message: string };
}

const PERCENT_MAX = 100;

function uploadAssetXhr(projectId: string, input: UploadAssetInput): Promise<Asset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${API_BASE_URL}${base(projectId)}/${input.kind}?name=${encodeURIComponent(input.name)}`;
    xhr.open("POST", url, true);
    // Matches the dashboard-wide `credentials: "include"` convention
    // (see api.ts) — the Better Auth session cookie must round-trip on
    // this request the same as every other dashboard call.
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (!input.onProgress || !event.lengthComputable) return;
      input.onProgress(Math.round((event.loaded / event.total) * PERCENT_MAX));
    };

    xhr.onload = () => {
      let envelope: UploadEnvelope | null = null;
      try {
        envelope = JSON.parse(xhr.responseText) as UploadEnvelope;
      } catch {
        envelope = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && envelope?.data) {
        resolve(envelope.data);
        return;
      }
      reject(
        new ApiError(
          envelope?.error?.code ?? `HTTP_${xhr.status}`,
          envelope?.error?.message ?? xhr.statusText ?? "Upload failed",
          xhr.status,
        ),
      );
    };
    xhr.onerror = () => {
      reject(new ApiError("NETWORK_ERROR", "Network error during upload", 0));
    };

    xhr.send(input.file);
  });
}

export function useUploadAsset(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadAssetInput) => uploadAssetXhr(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}

export function useDeleteAsset(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) =>
      api<{ deleted: boolean }>(`${base(projectId)}/${assetId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}
