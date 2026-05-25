import { useMemo } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import {
  EMPTY_FORM,
  ProjectSetupWizard,
} from "../../components/project-setup";
import type { SetupForm } from "../../components/project-setup";
import { useProject } from "../../lib/hooks/useProject";
import { useUpdateProject } from "../../lib/hooks/useUpdateProject";

export const Route = createFileRoute("/_authed/projects/$projectId/edit")({
  component: ProjectSetupEdit,
});

function ProjectSetupEdit() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/edit",
  });
  const navigate = useNavigate();
  const { data: project, isLoading } = useProject(projectId);
  const updateProject = useUpdateProject(projectId);

  const initialForm = useMemo<SetupForm | undefined>(() => {
    if (!project) return undefined;
    const settings = (project.settings ?? {}) as Partial<SetupForm>;
    return {
      ...EMPTY_FORM,
      ...settings,
      name: project.name,
    };
  }, [project]);

  if (isLoading || !project || !initialForm) return null;

  const handleSubmit = (form: SetupForm) => {
    const { name, ...settings } = form;
    updateProject.mutate(
      { name, settings },
      {
        onSuccess: () => {
          navigate({
            to: "/projects/$projectId",
            params: { projectId: project.id },
          });
        },
      },
    );
  };

  return (
    <ProjectSetupWizard
      mode="update"
      initialForm={initialForm}
      projectName={project.name}
      onSubmit={handleSubmit}
      isSubmitting={updateProject.isPending}
    />
  );
}
