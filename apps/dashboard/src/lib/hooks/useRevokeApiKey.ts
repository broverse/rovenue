import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export function useRevokeApiKey(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      api<{ id: string }>(`/dashboard/projects/${projectId}/api-keys/${keyId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });
}
