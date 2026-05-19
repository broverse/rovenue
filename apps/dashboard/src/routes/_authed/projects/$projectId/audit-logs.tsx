import { useMemo } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../ui/button";
import { useProject } from "../../../../lib/hooks/useProject";
import { useAuditLogs } from "../../../../lib/hooks/useProjectAdmin";

export const Route = createFileRoute("/_authed/projects/$projectId/audit-logs")({
  component: AuditLogsRoute,
});

function AuditLogsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/audit-logs",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AuditLogsPage projectId={projectId} />;
}

function AuditLogsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useAuditLogs({
    projectId,
  });

  const rows = useMemo(
    () => data?.pages.flatMap((p) => p.logs) ?? [],
    [data],
  );
  const total = data?.pages[0]?.pagination.total ?? 0;

  return (
    <>
      <header className="pb-5">
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
          {t("auditLogs.title", "Audit log")}
        </h1>
        <p className="mt-1 text-[13px] text-rv-mute-500">
          {t(
            "auditLogs.subtitle",
            "Every privileged action on this project, tamper-evident via per-project hash chain.",
          )}
        </p>
      </header>

      <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <div className="flex items-center justify-between border-b border-rv-divider px-4 py-3 text-[12px] text-rv-mute-500">
          <span>
            {t("auditLogs.count", "{{shown}} of {{total}}", {
              shown: rows.length,
              total,
            })}
          </span>
        </div>
        <div className="grid grid-cols-[140px_minmax(0,1fr)_120px_120px_180px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          <span>{t("auditLogs.cols.when", "When")}</span>
          <span>{t("auditLogs.cols.action", "Action")}</span>
          <span>{t("auditLogs.cols.resource", "Resource")}</span>
          <span>{t("auditLogs.cols.user", "User")}</span>
          <span className="font-rv-mono">{t("auditLogs.cols.id", "ID")}</span>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("auditLogs.empty", "No audit entries yet.")}
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[140px_minmax(0,1fr)_120px_120px_180px] items-center gap-3 border-b border-rv-divider px-4 py-2 text-[12px] last:border-b-0"
            >
              <span className="font-rv-mono text-rv-mute-500">
                {new Date(row.createdAt).toLocaleString()}
              </span>
              <span className="truncate font-rv-mono">{row.action}</span>
              <span className="truncate">{row.resource}</span>
              <span className="truncate font-rv-mono text-rv-mute-500">
                {row.userId.slice(0, 12)}…
              </span>
              <span className="truncate font-rv-mono text-rv-mute-500">
                {row.resourceId}
              </span>
            </div>
          ))
        )}
        {hasNextPage && (
          <div className="flex justify-center px-4 py-3">
            <Button
              variant="flat"
              size="sm"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage
                ? t("common.loading", "Loading…")
                : t("common.loadMore", "Load more")}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
