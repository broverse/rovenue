import { createFileRoute, useParams } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useProject } from "../../../../lib/hooks/useProject";
import { SettingsForm } from "../../../../components/projects/SettingsForm";
import { RotateSecretDialog } from "../../../../components/projects/RotateSecretDialog";
import { DeleteProjectDialog } from "../../../../components/projects/DeleteProjectDialog";

export const Route = createFileRoute("/_authed/projects/$projectId/settings")({
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/settings" });
  const { data: project } = useProject(projectId);

  if (!project) return null;

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold">General</h2>
        <SettingsForm project={project} />
      </Card>

      <Card className="p-6">
        <h2 className="mb-2 text-lg font-semibold">Webhook secret</h2>
        <p className="mb-4 text-sm text-default-500">
          {project.hasWebhookSecret
            ? "A webhook signing secret is currently configured. Rotating generates a new one and invalidates the old value immediately."
            : "No webhook secret is set. Rotate to generate one."}
        </p>
        <RotateSecretDialog projectId={project.id} />
      </Card>

      <Card className="border border-danger-200 p-6">
        <h2 className="mb-2 text-lg font-semibold text-danger-500">
          Danger zone
        </h2>
        <p className="mb-4 text-sm text-default-500">
          Deleting a project is permanent and cannot be undone.
        </p>
        <DeleteProjectDialog
          projectId={project.id}
          projectName={project.name}
        />
      </Card>
    </div>
  );
}
