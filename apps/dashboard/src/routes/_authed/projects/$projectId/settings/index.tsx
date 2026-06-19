import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Card } from "../../../../../ui/card";
import { useProject } from "../../../../../lib/hooks/useProject";
import { SettingsForm } from "../../../../../components/projects/SettingsForm";
import { ReportingForm } from "../../../../../components/projects/ReportingForm";
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
        <div className="mb-4">
          <h2 className="text-lg font-semibold">{t("projects.settings.basicsHeader")}</h2>
          <p className="mt-1 text-sm text-default-500">
            {t("projects.settings.basicsDescription")}
          </p>
        </div>
        <SettingsForm project={project} />
      </Card>

      <Card className="p-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">{t("projects.settings.reportingHeader")}</h2>
          <p className="mt-1 text-sm text-default-500">
            {t("projects.settings.reportingDescription")}
          </p>
        </div>
        <ReportingForm project={project} />
      </Card>

      <Card className="border-rv-danger/30 p-6">
        <h2 className="mb-2 text-lg font-semibold text-rv-danger">
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
