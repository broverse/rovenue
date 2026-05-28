import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Spinner } from "@heroui/react";
import { Button } from "../../../../../ui/button";
import { useRefundShieldResponses } from "../../../../../lib/hooks/useRefundShield";
import {
  ResponsesFilterBar,
  type ResponsesFilters,
} from "../../../../../components/refund-shield/responses-filter-bar";
import { ResponsesTable } from "../../../../../components/refund-shield/responses-table";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/refund-shield/responses",
)({
  component: RefundShieldResponsesRoute,
});

function RefundShieldResponsesRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/refund-shield/responses",
  });
  return <RefundShieldResponsesPage projectId={projectId} />;
}

export function RefundShieldResponsesPage({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<ResponsesFilters>({});
  const query = useRefundShieldResponses(projectId, filters);

  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.responses) ?? [],
    [query.data],
  );

  return (
    <>
      <header className="mb-4">
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
          {t("refundShield.responses.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
          {t("refundShield.subtitle")}
        </p>
      </header>

      <ResponsesFilterBar value={filters} onChange={setFilters} />

      {query.isLoading ? (
        <div className="flex items-center gap-2 text-rv-mute-500">
          <Spinner /> <span className="text-sm">{t("common.loading")}</span>
        </div>
      ) : (
        <ResponsesTable projectId={projectId} rows={rows} />
      )}

      {query.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="flat"
            size="sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {t("refundShield.responses.loadMore")}
          </Button>
        </div>
      )}
    </>
  );
}
