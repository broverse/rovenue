import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CohortForm } from "../../../../../components/cohorts/cohort-form";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/cohorts/new",
)({
  component: NewCohortRouteComponent,
});

function NewCohortRouteComponent() {
  const { t } = useTranslation();
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/cohorts/new",
  });
  const navigate = useNavigate();

  return (
    <>
      <header className="pb-5">
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
          {t("cohorts.new.title")}
        </h1>
        <p className="mt-0.5 text-[13px] text-rv-mute-500">
          {t("cohorts.new.subtitle")}
        </p>
      </header>

      <CohortForm
        mode="create"
        projectId={projectId}
        onSuccess={(id) =>
          navigate({
            to: "/projects/$projectId/cohorts",
            params: { projectId },
            search: { selected: id },
          })
        }
        onCancel={() =>
          navigate({
            to: "/projects/$projectId/cohorts",
            params: { projectId },
          })
        }
      />
    </>
  );
}
