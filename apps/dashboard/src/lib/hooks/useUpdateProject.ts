import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectDetail, UpdateProjectRequest } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useUpdateProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectRequest) =>
      unwrap<{ project: ProjectDetail }>(
        rpc.dashboard.projects[":id"].$patch({
          param: { id: projectId },
          json: body,
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
