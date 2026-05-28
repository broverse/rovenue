import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Spinner } from "@heroui/react";
import { ArrowLeft } from "lucide-react";
import { useRefundShieldResponse } from "../../../../../lib/hooks/useRefundShield";
import {
  JsonPayloadViewer,
  ResponseTimeline,
  StatusChip,
  OutcomeChip,
} from "../../../../../components/refund-shield";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield/responses_/$rid",
)({
  component: RefundShieldResponseDetailRoute,
});

function RefundShieldResponseDetailRoute() {
  const { projectId, rid } = useParams({
    from: "/_authed/projects/$projectId/refund-shield/responses_/$rid",
  });
  return <RefundShieldResponseDetailPage projectId={projectId} rid={rid} />;
}

export function RefundShieldResponseDetailPage({
  projectId,
  rid,
}: {
  projectId: string;
  rid: string;
}) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useRefundShieldResponse(projectId, rid);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-rv-mute-500">
        <Spinner /> <span className="text-sm">{t("common.loading")}</span>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="text-rv-danger">
        {error?.message ?? t("common.notFound")}
      </div>
    );
  }

  return (
    <>
      <header className="mb-5">
        <Link
          to="/projects/$projectId/refund-shield/responses"
          params={{ projectId }}
          className="inline-flex items-center gap-1 text-[12px] text-rv-mute-500 hover:text-foreground"
        >
          <ArrowLeft size={12} />
          {t("refundShield.detail.back")}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-rv-mono text-[18px] font-medium">
            {data.appleTransactionId}
          </h1>
          <StatusChip status={data.status} />
          <OutcomeChip outcome={data.outcome} />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex flex-col gap-4">
          <Card title={t("refundShield.detail.timeline.title")}>
            <ResponseTimeline response={data} />
          </Card>

          <Card
            title={t("refundShield.detail.payload.title")}
            subtitle={t("refundShield.detail.payload.subtitle", {
              txn: data.appleTransactionId,
            })}
          >
            <JsonPayloadViewer payload={data.requestPayload} />
          </Card>

          <Card title={t("refundShield.detail.appleResponse.title")}>
            {data.appleHttpStatus ? (
              <>
                <div className="text-[12px] text-rv-mute-700">
                  {t("refundShield.detail.appleResponse.status", {
                    status: data.appleHttpStatus,
                  })}
                </div>
                {data.appleResponseBody ? (
                  <pre className="mt-2 overflow-x-auto rounded-md border border-rv-divider bg-rv-c1 px-3 py-2 font-rv-mono text-[11px] text-rv-mute-700">
                    {data.appleResponseBody}
                  </pre>
                ) : null}
              </>
            ) : (
              <p className="text-[12px] text-rv-mute-500">
                {t("refundShield.detail.appleResponse.empty")}
              </p>
            )}
          </Card>
        </section>

        <aside>
          <Card title={t("refundShield.detail.subscriber.title")}>
            {data.subscriberId ? (
              <Link
                to="/projects/$projectId/subscribers/$id"
                params={{ projectId, id: data.subscriberId }}
                className="inline-flex items-center gap-1 font-rv-mono text-[12px] text-rv-accent-500 hover:underline"
              >
                {t("refundShield.detail.linkSubscriber")}
                <span className="text-rv-mute-500">
                  {data.subscriberId.slice(0, 8)}…
                </span>
              </Link>
            ) : (
              <p className="text-[12px] text-rv-mute-500">
                {t("refundShield.detail.subscriber.missing")}
              </p>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      <header className="border-b border-rv-divider bg-rv-c2/40 px-4 py-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 text-[11px] text-rv-mute-500">{subtitle}</p>
        )}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
