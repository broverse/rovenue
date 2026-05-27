import { createFileRoute, useParams } from "@tanstack/react-router";
import { BuilderShell } from "../../../../../components/funnel-builder";
import { BuilderProvider } from "../../../../../components/funnel-builder/builder-provider";
import { useProject } from "../../../../../lib/hooks/useProject";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/funnels/$funnelId",
)({
  component: FunnelBuilderRoute,
});

function FunnelBuilderRoute() {
  const { projectId, funnelId } = useParams({
    from: "/_authed/projects/$projectId/funnels/$funnelId",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return (
    <BuilderProvider projectId={projectId} funnelId={funnelId}>
      <BuilderShell projectId={projectId} />
    </BuilderProvider>
  );
}
