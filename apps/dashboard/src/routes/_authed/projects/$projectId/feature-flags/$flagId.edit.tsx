import { useTranslation } from "react-i18next";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { FlagForm } from "../../../../../components/feature-flags/flag-form";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useFeatureFlag } from "../../../../../lib/hooks/useFeatureFlags";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/feature-flags/$flagId/edit",
)({
  component: EditFeatureFlagRouteComponent,
});

function EditFeatureFlagRouteComponent() {
  const { t } = useTranslation();
  const { projectId, flagId } = useParams({
    from: "/_authed/projects/$projectId/feature-flags/$flagId/edit",
  });
  const { data: project } = useProject(projectId);
  const { data: flag, isLoading, error } = useFeatureFlag(flagId);

  if (!project) return null;
  if (isLoading) {
    return (
      <div className="flex h-[200px] items-center justify-center text-[13px] text-rv-mute-500">
        {t("featureFlags.edit.loading")}
      </div>
    );
  }
  if (error || !flag) {
    return (
      <div className="flex h-[200px] items-center justify-center text-[13px] text-rv-danger">
        {t("featureFlags.edit.notFound")}
      </div>
    );
  }
  return <FlagForm projectId={projectId} initialFlag={flag} />;
}
