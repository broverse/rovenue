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
  // Keyed on the paywall's identity so navigating between two builder URLs
  // remounts the whole subtree. Without it the builder keeps showing the
  // PREVIOUS paywall: TanStack Router only remounts on a param change when
  // `remountDeps` is configured (it isn't, anywhere), and impair's
  // ServiceProvider mutates its reactive props in place while caching the
  // container and the view-model instance — so `@onMount load()` never
  // re-runs and nothing refetches.
  return (
    <PaywallBuilderProvider
      key={`${projectId}/${paywallId}`}
      projectId={projectId}
      paywallId={paywallId}
    >
      <BuilderShell projectId={projectId} />
    </PaywallBuilderProvider>
  );
}
