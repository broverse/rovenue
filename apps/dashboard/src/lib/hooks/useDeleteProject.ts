import { useMutation, useQueryClient } from "@tanstack/react-query";
import { rpc, unwrap } from "../api";

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      unwrap<{ id: string }>(
        rpc.dashboard.projects[":id"].$delete({ param: { id: projectId } }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
