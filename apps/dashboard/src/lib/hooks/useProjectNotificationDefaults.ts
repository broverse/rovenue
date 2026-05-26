import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";

interface DefaultsResponse {
  projectId: string;
  defaults: Record<string, boolean>;
}

const KEY = (projectId: string) =>
  ["projects", projectId, "notification-defaults"] as const;

export function useProjectNotificationDefaults(projectId: string) {
  return useQuery({
    queryKey: KEY(projectId),
    queryFn: () =>
      api<DefaultsResponse>(
        `/dashboard/projects/${projectId}/notification-defaults`,
      ),
    select: (r) => r.defaults,
  });
}

export function useUpdateProjectNotificationDefaults(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (defaults: Record<string, boolean>) =>
      api<{ ok: boolean }>(
        `/dashboard/projects/${projectId}/notification-defaults`,
        { method: "PATCH", body: JSON.stringify({ defaults }) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY(projectId) });
    },
  });
}
