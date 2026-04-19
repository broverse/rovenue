import { useNavigate } from "@tanstack/react-router";
import { useProjects } from "../../lib/hooks/useProjects";

// HeroUI v3 Select is a complex react-aria composition; a native <select>
// keeps the switcher small and accessible without pulling that machinery in.
export function ProjectSwitcher({ currentProjectId }: { currentProjectId: string }) {
  const navigate = useNavigate();
  const { data } = useProjects();

  return (
    <select
      aria-label="Switch project"
      value={currentProjectId}
      onChange={(e) => {
        const nextId = e.target.value;
        if (!nextId || nextId === currentProjectId) return;
        try {
          localStorage.setItem("lastProjectId", nextId);
        } catch {
          // ignore storage failures (private mode, quota, etc.)
        }
        void navigate({
          to: "/projects/$projectId",
          params: { projectId: nextId },
        });
      }}
      className="h-9 rounded-medium border border-default-200 bg-content1 px-3 text-sm focus:border-primary focus:outline-none"
    >
      {data?.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      )) ?? <option value={currentProjectId}>Loading...</option>}
    </select>
  );
}
