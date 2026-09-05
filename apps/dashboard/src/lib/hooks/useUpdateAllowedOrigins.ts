import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Replaces a key's browser origin allow-list.
 *
 * The whole list is sent rather than a delta: a merge would make removing an
 * origin impossible to express, and removal is the operation that actually
 * matters here — it is how access is taken away.
 */
export function useUpdateAllowedOrigins(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      keyId,
      allowedOrigins,
    }: {
      keyId: string;
      allowedOrigins: string[];
    }) =>
      api<{ allowedOrigins: string[] }>(
        `/dashboard/projects/${projectId}/api-keys/${keyId}/allowed-origins`,
        { method: "PATCH", body: JSON.stringify({ allowedOrigins }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });
}
