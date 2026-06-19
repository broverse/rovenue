import { Link, createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useExperiment } from "../../../../../lib/hooks/useExperiments";
import {
  ExperimentDetailPanel,
  mapApiExperiment,
} from "../../../../../components/experiments";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/experiments/$experimentId/",
)({
  component: ExperimentDetailRouteComponent,
});

function ExperimentDetailRouteComponent() {
  const { projectId, experimentId } = useParams({
    from: "/_authed/projects/$projectId/experiments/$experimentId/",
  });
  const { data: project } = useProject(projectId);
  const { data, isLoading, error } = useExperiment(experimentId);
  const { t } = useTranslation();

  if (!project || isLoading) return null;

  if (error || !data?.experiment) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
        <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
        <span>{t("experiments.detail.notFound")}</span>
      </div>
    );
  }

  const summary = mapApiExperiment(data.experiment);

  return (
    <>
      <div className="pb-4">
        <Link
          to="/projects/$projectId/experiments"
          params={{ projectId }}
          className="inline-flex items-center gap-1.5 text-[12px] text-rv-mute-500 transition-colors hover:text-foreground"
        >
          <ArrowLeft size={13} />
          {t("experiments.detail.back")}
        </Link>
      </div>
      <ExperimentDetailPanel experiment={summary} projectId={projectId} />
    </>
  );
}
