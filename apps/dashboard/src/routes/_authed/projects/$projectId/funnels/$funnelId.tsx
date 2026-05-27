import { createFileRoute, useParams } from "@tanstack/react-router";
import { BuilderShell } from "../../../../../components/funnel-builder";
import { useProject } from "../../../../../lib/hooks/useProject";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/funnels/$funnelId",
)({
  component: FunnelBuilderRoute,
});

function FunnelBuilderRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/funnels/$funnelId",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  // The Builder owns the full viewport via `fixed inset-0` and reads
  // funnel data from a static mock — `funnelId` isn't wired through
  // yet because the demo funnel is hard-coded. Once the backend
  // returns funnels, swap this for a fetch keyed off the param.
  return <BuilderShell projectId={projectId} />;
}
