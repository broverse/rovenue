import { createFileRoute, Outlet, useChildMatches, useParams } from "@tanstack/react-router";
import { Spinner } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { TopNav } from "../../../../components/layout/TopNav";
import { DashboardShell } from "../../../../components/dashboard";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId")({
  component: ProjectLayout,
});

/**
 * Best-effort breadcrumb key derived from the deepest active route id.
 * Returns an i18n key that the layout resolves via `t()` so the displayed
 * label stays localized.
 */
function useBreadcrumbTitleKey(): string {
  const matches = useChildMatches();
  const last = matches[matches.length - 1];
  const id = last?.routeId ?? "";
  if (id.includes("/subscribers/$id")) return "breadcrumb.subscriber";
  if (id.includes("/subscribers/")) return "breadcrumb.subscribers";
  if (id.includes("/settings")) return "breadcrumb.settings";
  if (id.includes("/live-events")) return "breadcrumb.liveEvents";
  return "breadcrumb.overview";
}

function ProjectLayout() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/_authed/projects/$projectId" });
  const { data: project, isLoading, error } = useProject(projectId);
  const current = t(useBreadcrumbTitleKey());

  if (isLoading) {
    return (
      <>
        <TopNav />
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-6 py-8 text-default-500">
          <Spinner />
          <span className="text-sm">{t("common.loadingProject")}</span>
        </div>
      </>
    );
  }

  if (error || !project) {
    return (
      <>
        <TopNav />
        <div className="mx-auto max-w-6xl px-6 py-8">
          <div role="alert" className="rounded-lg border border-default-200 p-6 text-default-500">
            {t("common.projectNotFound")}
          </div>
        </div>
      </>
    );
  }

  return (
    <DashboardShell projectId={project.id} projectName={project.name} current={current}>
      <Outlet />
    </DashboardShell>
  );
}
