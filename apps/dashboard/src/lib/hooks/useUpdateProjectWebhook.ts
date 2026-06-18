import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectDetail, UpdateProjectRequest } from "@rovenue/shared";
import { api } from "../api";

type WebhookPatch = Pick<UpdateProjectRequest, "webhookUrl" | "webhookEventCategories">;

export function useUpdateProjectWebhook(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: WebhookPatch) =>
      api<{ project: ProjectDetail }>(`/dashboard/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (res) => {
      qc.setQueryData(["project", projectId], res.project);
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
}
