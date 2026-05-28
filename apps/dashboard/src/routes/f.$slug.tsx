import { createFileRoute } from "@tanstack/react-router";
import { FunnelRunner } from "../runner/funnel-runner";

// Public funnel runner — lives outside the `_authed` layout so it's
// accessible without a dashboard session. URL shape: `/f/<slug>`.
export const Route = createFileRoute("/f/$slug")({
  component: RunnerRoute,
});

function RunnerRoute() {
  const { slug } = Route.useParams();
  return <FunnelRunner slug={slug} />;
}
