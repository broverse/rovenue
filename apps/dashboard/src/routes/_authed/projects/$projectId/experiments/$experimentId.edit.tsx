import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useExperiment } from "../../../../../lib/hooks/useExperiments";
import { NewExperimentPage } from "./new";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/experiments/$experimentId/edit",
)({
  component: EditExperimentRouteComponent,
});

function EditExperimentRouteComponent() {
  const { projectId, experimentId } = useParams({
    from: "/_authed/projects/$projectId/experiments/$experimentId/edit",
  });
  const { data: project } = useProject(projectId);
  const { data, isLoading, error } = useExperiment(experimentId);
  const { t } = useTranslation();

  if (!project || isLoading) return null;

  if (error || !data?.experiment) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
        <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
        <span>{t("experiments.edit.notFound")}</span>
      </div>
    );
  }

  // Lifecycle bar + per-status form locking is handled inside
  // NewExperimentPage — we just hand it the loaded experiment.
  return (
    <NewExperimentPage
      projectId={projectId}
      initialExperiment={data.experiment}
    />
  );
}
