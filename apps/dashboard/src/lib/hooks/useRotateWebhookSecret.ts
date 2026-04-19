import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RotateWebhookSecretResponse } from "@rovenue/shared";
import { api } from "../api";

export function useRotateWebhookSecret(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<RotateWebhookSecretResponse>(
        `/dashboard/projects/${projectId}/webhook-secret/rotate`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });
}
