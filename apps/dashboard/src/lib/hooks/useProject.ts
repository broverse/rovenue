import { useQuery } from "@tanstack/react-query";
import type { ProjectDetail } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id],
    enabled: Boolean(id),
    queryFn: () =>
      unwrap<{ project: ProjectDetail }>(
        rpc.dashboard.projects[":id"].$get({ param: { id: id! } }),
      ),
    select: (res) => res.project,
  });
}
