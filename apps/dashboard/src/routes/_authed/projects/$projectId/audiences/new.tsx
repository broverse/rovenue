import { createFileRoute, useParams } from "@tanstack/react-router";
import { useProject } from "../../../../../lib/hooks/useProject";
import { AudienceForm } from "../../../../../components/audiences/audience-form";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/audiences/new",
)({
  component: NewAudienceRouteComponent,
});

function NewAudienceRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/audiences/new",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AudienceForm projectId={projectId} />;
}
