import { useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Pencil, Webhook } from "lucide-react";
import type { WebhookDelivery } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import { Chip, type ChipProps } from "../../../../ui/chip";
import { CopyButton } from "../../../../ui/copy-button";
import { CustomWebhookModal } from "../../../../components/apps/custom-webhook-modal";
import { LoadingState } from "../../../../components/dashboard/loading-state";
import { EmptyStateCard } from "../../../../components/dashboard/empty-state-card";
import { useProject } from "../../../../lib/hooks/useProject";
import { useRotateWebhookSecret } from "../../../../lib/hooks/useRotateWebhookSecret";
import { useWebhookDeliveries } from "../../../../lib/hooks/useWebhookDeliveries";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/apps_/webhooks",
)({
  component: WebhookDetailRoute,
});

function WebhookDetailRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/apps_/webhooks",
  });
  return <WebhookDetailPage projectId={projectId} />;
}

// SENT → success; PENDING/DELIVERING/FAILED → warning; DEAD → danger;
// DISMISSED → neutral.
function statusTone(status: string): NonNullable<ChipProps["tone"]> {
  if (status === "SENT") return "success";
  if (status === "DEAD") return "danger";
  if (status === "DISMISSED") return "default";
  return "warning";
}

function WebhookDetailPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: project } = useProject(projectId);
  const rotate = useRotateWebhookSecret(projectId);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const deliveries = useWebhookDeliveries(projectId, page);

  if (!project) return <LoadingState />;

  const hasWebhook = Boolean(project.webhookUrl);

  const handleRotate = async () => {
    try {
      const res = await rotate.mutateAsync();
      setRevealedSecret(res.webhookSecret);
    } catch {
      /* surfaced via rotate.isError */
    }
  };

  return (
    <>
      <header className="pb-5">
        <Link
          to="/projects/$projectId/apps"
          params={{ projectId }}
          className="inline-flex items-center gap-1 text-[12px] text-rv-mute-500 hover:text-foreground"
        >
          <ArrowLeft size={12} />
          {t("apps.webhookDetail.back")}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold leading-7 tracking-tight">
              {t("apps.webhookDetail.title")}
            </h1>
            <p className="mt-1 text-[12.5px] text-rv-mute-500">
              {t("apps.webhookDetail.subtitle")}
            </p>
          </div>
          {hasWebhook && (
            <Button variant="flat" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil size={13} />
              {t("apps.webhookDetail.edit")}
            </Button>
          )}
        </div>
      </header>

      {!hasWebhook ? (
        <EmptyStateCard
          icon={Webhook}
          title={t("apps.webhookDetail.noWebhook.title")}
          description={t("apps.webhookDetail.noWebhook.description")}
          actions={
            <Button variant="solid-primary" size="sm" onClick={() => setEditOpen(true)}>
              {t("apps.webhookDetail.noWebhook.cta")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Config + secret */}
          <section className="grid gap-3 rounded-lg border border-rv-divider bg-rv-c1 px-4 py-4 sm:grid-cols-2 sm:px-5">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("apps.webhookDetail.endpointLabel")}
              </div>
              <div className="mt-1 flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-3 py-1.5">
                <code className="truncate font-rv-mono text-[12px] text-foreground">
                  {project.webhookUrl}
                </code>
                <CopyButton size="xs" value={project.webhookUrl ?? ""} />
              </div>
              <div className="mt-3 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("apps.webhookDetail.eventsLabel")}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {project.webhookEventCategories.length === 0 ? (
                  <Chip tone="default">{t("apps.webhookDetail.allEvents")}</Chip>
                ) : (
                  project.webhookEventCategories.map((c) => (
                    <Chip key={c} tone="default">
                      {t(`apps.customWebhook.categories.${c}`)}
                    </Chip>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("apps.webhookDetail.secretLabel")}
              </div>
              {revealedSecret ? (
                <div className="mt-1 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <code className="truncate font-rv-mono text-[12px] text-foreground">
                      {revealedSecret}
                    </code>
                    <CopyButton size="xs" value={revealedSecret} />
                  </div>
                  <p className="mt-1 text-[11px] text-rv-warning">
                    {t("apps.webhookDetail.secretRevealWarning")}
                  </p>
                </div>
              ) : (
                <div className="mt-1 flex items-center gap-2">
                  <Chip tone={project.hasWebhookSecret ? "success" : "warning"}>
                    {project.hasWebhookSecret
                      ? t("apps.webhookDetail.secretConfigured")
                      : t("apps.webhookDetail.secretMissing")}
                  </Chip>
                  <Button
                    variant="flat"
                    size="sm"
                    onClick={handleRotate}
                    disabled={rotate.isPending}
                    type="button"
                  >
                    {rotate.isPending
                      ? t("apps.webhookDetail.rotating")
                      : t("apps.webhookDetail.rotate")}
                  </Button>
                </div>
              )}
            </div>
          </section>

          {/* Delivery history */}
          <section className="rounded-lg border border-rv-divider bg-rv-c1">
            <header className="border-b border-rv-divider px-4 py-3 sm:px-5">
              <h3 className="text-[13px] font-semibold text-foreground">
                {t("apps.webhookDetail.deliveries.title")}
              </h3>
            </header>
            {deliveries.isLoading ? (
              <LoadingState />
            ) : (deliveries.data?.webhooks.length ?? 0) === 0 ? (
              <EmptyStateCard
                icon={Webhook}
                title={t("apps.webhookDetail.deliveries.empty")}
                description={t("apps.webhookDetail.deliveries.emptyHint")}
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead className="text-[11px] uppercase tracking-wider text-rv-mute-500">
                      <tr className="border-b border-rv-divider">
                        <th className="px-4 py-2 font-medium sm:px-5">
                          {t("apps.webhookDetail.deliveries.colStatus")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colEvent")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colStatusCode")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colAttempts")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colCreated")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colSent")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colError")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.data!.webhooks.map((d: WebhookDelivery) => (
                        <tr key={d.id} className="border-b border-rv-divider last:border-0">
                          <td className="px-4 py-2 sm:px-5">
                            <Chip tone={statusTone(d.status)}>{d.status}</Chip>
                          </td>
                          <td className="px-4 py-2 font-rv-mono text-[11.5px]">{d.eventType}</td>
                          <td className="px-4 py-2 font-rv-mono tabular-nums text-rv-mute-600">
                            {d.httpStatus ?? "—"}
                          </td>
                          <td className="px-4 py-2 tabular-nums">{d.attempts}</td>
                          <td className="px-4 py-2 text-rv-mute-600">
                            {new Date(d.createdAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-rv-mute-600">
                            {d.sentAt ? new Date(d.sentAt).toLocaleString() : "—"}
                          </td>
                          <td className="max-w-[220px] truncate px-4 py-2 text-rv-danger">
                            {d.lastErrorMessage ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-4 py-2.5 sm:px-5">
                  <Button
                    variant="flat"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    {t("apps.webhookDetail.deliveries.prev")}
                  </Button>
                  <Button
                    variant="flat"
                    size="sm"
                    disabled={!deliveries.data?.pagination.hasMore}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    {t("apps.webhookDetail.deliveries.next")}
                  </Button>
                </footer>
              </>
            )}
          </section>
        </div>
      )}

      {editOpen && (
        <CustomWebhookModal open onClose={() => setEditOpen(false)} projectId={projectId} />
      )}
    </>
  );
}
