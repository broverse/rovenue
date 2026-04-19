import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api<{ id: string }>(`/dashboard/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
