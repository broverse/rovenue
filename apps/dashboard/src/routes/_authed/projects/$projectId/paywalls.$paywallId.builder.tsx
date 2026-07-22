import { createFileRoute, useParams } from "@tanstack/react-router";
import { BuilderShell, PaywallBuilderProvider } from "../../../../components/paywall-builder";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/paywalls/$paywallId/builder",
)({
  component: PaywallBuilderRoute,
});

function PaywallBuilderRoute() {
  const { projectId, paywallId } = useParams({
    from: "/_authed/projects/$projectId/paywalls/$paywallId/builder",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return (
    <PaywallBuilderProvider projectId={projectId} paywallId={paywallId}>
      <BuilderShell projectId={projectId} />
    </PaywallBuilderProvider>
  );
}
