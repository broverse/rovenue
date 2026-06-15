import { useMemo } from "react";
import { Button, Card } from "@heroui/react";
import { Trans, useTranslation } from "react-i18next";
import type {
  CreditHistoryEntry,
  SubscriberDetail,
} from "@rovenue/shared";
import { AccessTable } from "./AccessTable";
import { AttributesTable } from "./AttributesTable";
import { PurchasesTable } from "./PurchasesTable";
import { CreditLedgerTable } from "./CreditLedgerTable";
import { AssignmentsList } from "./AssignmentsList";
import { SubscriberRefundShieldCard } from "../refund-shield";
import {
  useAnonymizeSubscriber,
  useExportSubscriber,
  useSubscriberCreditHistory,
} from "../../lib/hooks/useSubscriberActions";

interface Props {
  data: SubscriberDetail;
  projectId: string;
}

export function SubscriberDetailPanel({ data, projectId }: Props) {
  const { t } = useTranslation();
  const anonymizeMutation = useAnonymizeSubscriber(projectId);
  const exportMutation = useExportSubscriber(projectId);
  const creditHistory = useSubscriberCreditHistory({
    projectId,
    subscriberId: data.id,
  });

  // Until the first CH page lands, fall back to the 20-row preview
  // embedded in the detail response so the table is never empty.
  const creditRows = useMemo<CreditHistoryEntry[]>(() => {
    if (!creditHistory.data) return data.creditLedger;
    return creditHistory.data.pages.flatMap((page) => page.entries);
  }, [creditHistory.data, data.creditLedger]);

  const handleAnonymize = () => {
    const confirmed = window.confirm(
      t(
        "subscribers.detail.confirmAnonymize",
        "Anonymize this subscriber? This cannot be undone.",
      ),
    );
    if (!confirmed) return;
    anonymizeMutation.mutate({ id: data.id });
  };

  const handleExport = () => {
    exportMutation.mutate(data.id);
  };

  const isAnonymized = data.deletedAt !== null;

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="text-2xl font-semibold">{data.appUserId}</div>
            <div className="flex flex-wrap gap-4 text-xs text-default-500">
              <span>
                {t("subscribers.detail.firstSeen", {
                  date: new Date(data.firstSeenAt).toLocaleString(),
                })}
              </span>
              <span>
                {t("subscribers.detail.lastSeen", {
                  date: new Date(data.lastSeenAt).toLocaleString(),
                })}
              </span>
              {data.deletedAt && (
                <span className="text-danger-500">
                  {t("subscribers.detail.deleted", {
                    date: new Date(data.deletedAt).toLocaleString(),
                  })}
                </span>
              )}
              {data.mergedInto && (
                <span>
                  {t("subscribers.detail.mergedInto", { id: data.mergedInto })}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="ghost"
              onPress={handleExport}
              isPending={exportMutation.isPending}
            >
              {t("subscribers.detail.actions.export", "Export")}
            </Button>
            <Button
              size="sm"
              variant="danger-soft"
              onPress={handleAnonymize}
              isPending={anonymizeMutation.isPending}
              isDisabled={isAnonymized}
            >
              {t("subscribers.detail.actions.anonymize", "Anonymize")}
            </Button>
          </div>
        </div>
        {exportMutation.isError && (
          <div className="mt-2 text-xs text-danger-500">
            {exportMutation.error?.message}
          </div>
        )}
        {anonymizeMutation.isError && (
          <div className="mt-2 text-xs text-danger-500">
            {anonymizeMutation.error?.message}
          </div>
        )}
        <div className="mt-4 text-sm">
          <h3 className="mb-2 text-default-500">
            {t("subscribers.detail.attributes")}
          </h3>
          <AttributesTable attributes={data.attributes} />
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold">
          {t("subscribers.detail.access")}
        </h2>
        <AccessTable projectId={projectId} rows={data.access} />
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold">
          {t("subscribers.detail.purchases")}
        </h2>
        <PurchasesTable rows={data.purchases} />
      </Card>

      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {t("subscribers.detail.credits")}
          </h2>
          <span className="text-sm text-default-500">
            <Trans
              i18nKey="subscribers.detail.balance"
              values={{ value: data.creditBalance }}
              components={[<b key="b" className="text-default-900" />]}
            />
          </span>
        </div>
        <CreditLedgerTable rows={creditRows} />
        {creditHistory.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              onPress={() => creditHistory.fetchNextPage()}
              isPending={creditHistory.isFetchingNextPage}
            >
              {t("subscribers.detail.actions.loadMoreCredits", "Load more")}
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold">
          {t("subscribers.detail.experiments")}
        </h2>
        <AssignmentsList rows={data.assignments} />
      </Card>

      <SubscriberRefundShieldCard
        projectId={projectId}
        subscriberId={data.id}
      />
    </div>
  );
}
