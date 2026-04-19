import { createFileRoute, useParams } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId/")({
  component: ProjectOverview,
});

function ProjectOverview() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/" });
  const { data: project } = useProject(projectId);

  // The parent layout already gates on load/error, so at this point either
  // project is defined or the layout returned early. Guard for TS anyway.
  if (!project) return null;

  const stats: Array<{ label: string; value: number }> = [
    { label: "Subscribers", value: project.counts.subscribers },
    { label: "Experiments", value: project.counts.experiments },
    { label: "Feature flags", value: project.counts.featureFlags },
    { label: "Active API keys", value: project.counts.activeApiKeys },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {stats.map((s) => (
        <Card key={s.label} className="p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-default-500">
            {s.label}
          </div>
          <div className="mt-2 text-3xl font-semibold">{s.value}</div>
        </Card>
      ))}
    </div>
  );
}
