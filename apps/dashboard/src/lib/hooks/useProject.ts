import { useQuery } from "@tanstack/react-query";
import type { ProjectDetail } from "@rovenue/shared";
import { api } from "../api";

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id],
    enabled: Boolean(id),
    queryFn: () => api<{ project: ProjectDetail }>(`/dashboard/projects/${id}`),
    select: (res) => res.project,
  });
}
