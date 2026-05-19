import { useQuery } from "@tanstack/react-query";
import type { ProjectSummary } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () =>
      unwrap<{ projects: ProjectSummary[] }>(rpc.dashboard.projects.$get()),
    select: (res) => res.projects,
  });
}
