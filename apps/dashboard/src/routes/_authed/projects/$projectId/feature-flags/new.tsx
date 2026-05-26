import { createFileRoute, useParams } from "@tanstack/react-router";
import { FlagForm } from "../../../../../components/feature-flags/flag-form";
import { useProject } from "../../../../../lib/hooks/useProject";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/feature-flags/new",
)({
  component: NewFeatureFlagRouteComponent,
});

function NewFeatureFlagRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/feature-flags/new",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <FlagForm projectId={projectId} />;
}
