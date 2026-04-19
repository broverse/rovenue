import { useQuery } from "@tanstack/react-query";
import type { ProjectSummary } from "@rovenue/shared";
import { api } from "../api";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: ProjectSummary[] }>("/dashboard/projects"),
    select: (res) => res.projects,
  });
}
