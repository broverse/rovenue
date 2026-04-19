import { Card, Chip } from "@heroui/react";
import { Link } from "@tanstack/react-router";
import type { ProjectSummary } from "@rovenue/shared";

// HeroUI v3 Chip colors: accent | danger | default | success | warning.
// There is no "primary" — ADMIN maps to "accent" instead.
const roleColor: Record<string, "success" | "accent" | "default"> = {
  OWNER: "success",
  ADMIN: "accent",
  VIEWER: "default",
};

export function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="block"
    >
      <Card className="h-full w-full p-4 hover:bg-default-100">
        <div className="flex items-center justify-between">
          <span className="text-base font-medium">{project.name}</span>
          <Chip size="sm" color={roleColor[project.role] ?? "default"}>
            {project.role}
          </Chip>
        </div>
        <div className="mt-2 text-xs text-default-500">
          Created {new Date(project.createdAt).toLocaleDateString()}
        </div>
      </Card>
    </Link>
  );
}
