import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useAudience } from "../../../../../lib/hooks/useProjectAdmin";
import { AudienceForm } from "../../../../../components/audiences/audience-form";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/audiences/$audienceId",
)({
  component: EditAudienceRouteComponent,
});

function EditAudienceRouteComponent() {
  const { projectId, audienceId } = useParams({
    from: "/_authed/projects/$projectId/audiences/$audienceId",
  });
  const { t } = useTranslation();
  const { data: project } = useProject(projectId);
  const { data: audience, isLoading, isError } = useAudience(audienceId);

  if (!project) return null;
  if (isLoading) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
        {t("audiences.form.loading")}
      </div>
    );
  }
  if (isError || !audience) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
        {t("audiences.form.notFound")}
      </div>
    );
  }
  return <AudienceForm projectId={projectId} initialAudience={audience} />;
}
