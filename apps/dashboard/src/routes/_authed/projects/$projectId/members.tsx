import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Chip } from "../../../../ui/chip";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectMembers } from "../../../../lib/hooks/useProjectAdmin";

export const Route = createFileRoute("/_authed/projects/$projectId/members")({
  component: MembersRoute,
});

function MembersRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/members",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <MembersPage projectId={projectId} />;
}

function MembersPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: members = [], isLoading } = useProjectMembers(projectId);

  return (
    <>
      <header className="pb-5">
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
          {t("members.title", "Members")}
        </h1>
        <p className="mt-1 text-[13px] text-rv-mute-500">
          {t(
            "members.subtitle",
            "Project access roster. Every project must keep at least one OWNER.",
          )}
        </p>
      </header>

      <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <div className="grid grid-cols-[minmax(0,1fr)_120px_160px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          <span>{t("members.cols.user", "User")}</span>
          <span>{t("members.cols.role", "Role")}</span>
          <span>{t("members.cols.since", "Member since")}</span>
        </div>
        {isLoading && members.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("common.loading", "Loading…")}
          </div>
        ) : members.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("members.empty", "No members yet.")}
          </div>
        ) : (
          members.map((m) => (
            <div
              key={m.id}
              className="grid grid-cols-[minmax(0,1fr)_120px_160px] items-center gap-3 border-b border-rv-divider px-4 py-2.5 text-[12px] last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {m.image ? (
                  <img
                    src={m.image}
                    alt=""
                    className="h-6 w-6 shrink-0 rounded-full"
                  />
                ) : (
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rv-c3 text-[10px] font-medium text-rv-mute-700">
                    {(m.name ?? m.email).slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {m.name ?? m.email}
                  </div>
                  {m.name && (
                    <div className="truncate text-[11px] text-rv-mute-500">
                      {m.email}
                    </div>
                  )}
                </div>
              </div>
              <Chip
                tone={
                  m.role === "OWNER"
                    ? "primary"
                    : m.role === "ADMIN"
                      ? "warning"
                      : "default"
                }
              >
                {t(`members.role.${m.role.toLowerCase()}`, m.role)}
              </Chip>
              <span className="font-rv-mono text-rv-mute-500">
                {new Date(m.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
