import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectDetail, UpdateProjectRequest } from "@rovenue/shared";
import { api } from "../api";

export function useUpdateProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectRequest) =>
      api<{ project: ProjectDetail }>(`/dashboard/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
