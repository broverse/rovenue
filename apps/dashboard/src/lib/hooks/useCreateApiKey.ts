import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateApiKeyRequest, CreateApiKeyResponse } from "@rovenue/shared";
import { api } from "../api";

export function useCreateApiKey(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateApiKeyRequest) =>
      api<CreateApiKeyResponse>(`/dashboard/projects/${projectId}/api-keys`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });
}
