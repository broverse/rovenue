import { createFileRoute, useParams } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { useProject } from "../../../../../lib/hooks/useProject";
import { SettingsForm } from "../../../../../components/projects/SettingsForm";
import { DeleteProjectDialog } from "../../../../../components/projects/DeleteProjectDialog";

export const Route = createFileRoute("/_authed/projects/$projectId/settings/")({
  component: ProjectGeneralSettingsPage,
});

function ProjectGeneralSettingsPage() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/settings/" });
  const { data: project } = useProject(projectId);

  if (!project) return null;

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold">{t("projects.settings.general")}</h2>
        <SettingsForm project={project} />
      </Card>

      <Card className="border border-danger-200 p-6">
        <h2 className="mb-2 text-lg font-semibold text-danger-500">
          {t("projects.settings.dangerZone")}
        </h2>
        <p className="mb-4 text-sm text-default-500">
          {t("projects.settings.dangerZoneDescription")}
        </p>
        <DeleteProjectDialog
          projectId={project.id}
          projectName={project.name}
        />
      </Card>
    </div>
  );
}
