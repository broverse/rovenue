import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL, api, unwrap } from "../api";

// =============================================================
// Dashboard: project fonts (paywall fonts wave E1)
// =============================================================
//
// Mirrors the shape of the other project-scoped CRUD hooks in this
// directory (e.g. useVirtualCurrencies.ts) for the list/delete calls,
// which both round-trip JSON and go through the shared `api()`
// helper. Upload is the one genuinely new shape: it's multipart, and
// `api()` unconditionally sets `content-type: application/json`
// whenever a body is present and no content-type header was already
// supplied — that would stomp the multipart boundary `fetch` sets
// automatically for a `FormData` body. So the upload mutation calls
// `fetch` + `unwrap` directly instead, bypassing `api()` for this one
// request only; `unwrap()` still handles the `{ data } / { error }`
// envelope identically to every other hook here.

const base = (projectId: string) => `/dashboard/projects/${projectId}/fonts`;

const listKey = (projectId: string) => ["fonts", projectId] as const;

export interface FontFace {
  id: string;
  weight: number;
  style: string;
  format: string;
  byteSize: number;
  /** SHA-256 hex of the face's bytes. Still meaningful data, but no
   *  longer how a client builds the file URL — see `fileUrl` below. */
  contentHash: string;
  /** Ready-to-use URL for this face's bytes; the server resolves the
   *  path, callers must not construct it themselves (wave E1 follow-up). */
  fileUrl: string;
}

export interface FontFamily {
  id: string;
  name: string;
  faces: FontFace[];
}

export type FontFaceStyle = "normal" | "italic";

export interface UploadFontFaceInput {
  file: File;
  weight: number;
  style: FontFaceStyle;
  /**
   * Exactly one of these must be set, matching the endpoint's own
   * `.refine` — a new family is created from `familyName`, or the
   * face is attached to an existing one via `familyId`.
   */
  familyName?: string;
  familyId?: string;
}

/**
 * A project's font families, each with its uploaded faces. The
 * response never carries face bytes (dashboard's `listFamiliesWithFaces`
 * repo call is metadata-only) — this is safe to poll/refetch freely.
 */
export function useFontFamilies(projectId: string | undefined) {
  return useQuery({
    queryKey: listKey(projectId ?? ""),
    enabled: Boolean(projectId),
    queryFn: () => api<FontFamily[]>(base(projectId!)),
  });
}

/** Uploads one font face (see module note above re: bypassing `api()`). */
export function useUploadFontFace(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadFontFaceInput) => {
      const form = new FormData();
      form.set("file", input.file);
      form.set("weight", String(input.weight));
      form.set("style", input.style);
      if (input.familyId) {
        form.set("familyId", input.familyId);
      } else if (input.familyName) {
        form.set("familyName", input.familyName);
      }

      return unwrap<FontFace>(
        fetch(`${API_BASE_URL}${base(projectId)}`, {
          method: "POST",
          credentials: "include",
          body: form,
        }),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}

/**
 * Soft-deletes a font family. Deleting a family a paywall still
 * references is allowed on purpose (design spec §4.1) — referencing
 * paywalls fall back to the system font. The dashboard is responsible
 * for stating that consequence in its own confirmation UI; this hook
 * has no "in use" guard to enforce it, matching the server route.
 */
export function useDeleteFontFamily(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (familyId: string) =>
      api<{ deleted: boolean }>(`${base(projectId)}/${familyId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}
