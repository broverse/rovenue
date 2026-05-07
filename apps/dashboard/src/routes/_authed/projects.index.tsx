import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button, Spinner } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { TopNav } from "../../components/layout/TopNav";
import { ProjectCard } from "../../components/projects/ProjectCard";
import { useProjects } from "../../lib/hooks/useProjects";

export const Route = createFileRoute("/_authed/projects/")({
  component: ProjectsList,
});

export function ProjectsList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading, error } = useProjects();

  useEffect(() => {
    if (data && data.length === 0) {
      navigate({ to: "/projects/setup", replace: true });
    }
  }, [data, navigate]);

  return (
    <>
      <TopNav />
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{t("projects.list.title")}</h1>
          <Link to="/projects/setup">
            <Button variant="primary">{t("projects.list.newProject")}</Button>
          </Link>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-default-500">
            <Spinner /> <span className="text-sm">{t("common.loading")}</span>
          </div>
        )}
        {error && (
          <div role="alert" className="text-danger-500">
            {error.message}
          </div>
        )}
        {data && data.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
