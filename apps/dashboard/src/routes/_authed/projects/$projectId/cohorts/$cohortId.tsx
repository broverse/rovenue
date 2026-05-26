import { useEffect } from "react";
import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Button } from "../../../../../ui/button";
import { CohortForm } from "../../../../../components/cohorts/cohort-form";
import {
  useCohortById,
  useDeleteCohort,
} from "../../../../../lib/hooks/useProjectCohorts";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/cohorts/$cohortId",
)({
  component: EditCohortRouteComponent,
});

function EditCohortRouteComponent() {
  const { t } = useTranslation();
  const { projectId, cohortId } = useParams({
    from: "/_authed/projects/$projectId/cohorts/$cohortId",
  });
  const navigate = useNavigate();

  const detail = useCohortById(projectId, cohortId);
  const del = useDeleteCohort(projectId);

  useEffect(() => {
    if (detail.error) {
      navigate({
        to: "/projects/$projectId/cohorts",
        params: { projectId },
      });
    }
  }, [detail.error, navigate, projectId]);

  if (detail.isLoading || !detail.data) {
    return <div className="py-10 text-[13px] text-rv-mute-500">{t("common.loading")}</div>;
  }

  const cohort = detail.data.cohort;

  async function onDelete() {
    const ok = window.confirm(
      t("cohorts.delete.confirm", { name: cohort.name }),
    );
    if (!ok) return;
    await del.mutateAsync(cohort.id);
    navigate({
      to: "/projects/$projectId/cohorts",
      params: { projectId },
    });
  }

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("cohorts.edit.title")}
          </h1>
          <p className="mt-0.5 text-[13px] text-rv-mute-500">
            {t("cohorts.edit.subtitle", { name: cohort.name })}
          </p>
        </div>
        <Button
          type="button"
          variant="flat"
          size="sm"
          onClick={onDelete}
          disabled={del.isPending}
        >
          <Trash2 size={12} />
          {t("cohorts.actions.delete")}
        </Button>
      </header>

      <CohortForm
        mode="edit"
        projectId={projectId}
        cohort={cohort}
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
