import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  DashboardFlagRule,
  DashboardFlagType,
  FeatureFlagDetailResponse,
  FeatureFlagListItem,
  FeatureFlagListResponse,
} from "@rovenue/shared";
import { api } from "../api";

export function useFeatureFlags(projectId: string) {
  return useQuery({
    queryKey: ["feature-flags", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<FeatureFlagListResponse>(
        `/dashboard/feature-flags?projectId=${encodeURIComponent(projectId)}`,
      ),
    select: (res) => res.flags,
  });
}

export function useFeatureFlag(id: string | undefined) {
  return useQuery({
    queryKey: ["feature-flag", id],
    enabled: Boolean(id),
    queryFn: () =>
      api<FeatureFlagDetailResponse>(`/dashboard/feature-flags/${id}`),
    select: (res) => res.flag,
  });
}

export function useToggleFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<FeatureFlagDetailResponse>(
        `/dashboard/feature-flags/${id}/toggle`,
        { method: "POST" },
      ),
    onMutate: async (id) => {
      // Optimistically flip the toggle so the UI reflects the
      // intent immediately. Roll back on error.
      await qc.cancelQueries({ queryKey: ["feature-flags"] });
      const snapshots: Array<{
        key: ReadonlyArray<unknown>;
        data: FeatureFlagListResponse | undefined;
      }> = [];
      qc.getQueriesData<FeatureFlagListResponse>({
        queryKey: ["feature-flags"],
      }).forEach(([key, data]) => {
        snapshots.push({ key, data });
        if (!data) return;
        qc.setQueryData<FeatureFlagListResponse>(key, {
          ...data,
          flags: data.flags.map((f) =>
            f.id === id ? { ...f, isEnabled: !f.isEnabled } : f,
          ),
        });
      });
      return { snapshots };
    },
    onError: (_err, _id, ctx) => {
      ctx?.snapshots.forEach(({ key, data }) => {
        qc.setQueryData(key, data);
      });
    },
    onSettled: (_data, _err, id) => {
      qc.invalidateQueries({ queryKey: ["feature-flags"] });
      qc.invalidateQueries({ queryKey: ["feature-flag", id] });
    },
  });
}

export interface CreateFlagVars {
  projectId: string;
  key: string;
  type: DashboardFlagType;
  defaultValue: unknown;
  rules?: DashboardFlagRule[];
  isEnabled?: boolean;
  description?: string | null;
}

export function useCreateFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: CreateFlagVars) =>
      api<FeatureFlagDetailResponse>("/dashboard/feature-flags", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feature-flags"] });
    },
  });
}

export interface UpdateFlagVars {
  id: string;
  body: {
    defaultValue?: unknown;
    rules?: DashboardFlagRule[];
    isEnabled?: boolean;
    description?: string | null;
  };
}

export function useUpdateFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: UpdateFlagVars) =>
      api<FeatureFlagDetailResponse>(`/dashboard/feature-flags/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ["feature-flags"] });
      qc.invalidateQueries({ queryKey: ["feature-flag", id] });
    },
  });
}

export function useDeleteFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(`/dashboard/feature-flags/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feature-flags"] });
    },
  });
}

export type { FeatureFlagListItem };
