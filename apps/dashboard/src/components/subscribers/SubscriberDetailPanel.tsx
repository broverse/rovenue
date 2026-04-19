import { Card } from "@heroui/react";
import type { SubscriberDetail } from "@rovenue/shared";
import { AccessTable } from "./AccessTable";
import { PurchasesTable } from "./PurchasesTable";
import { CreditLedgerTable } from "./CreditLedgerTable";
import { AssignmentsList } from "./AssignmentsList";

interface Props {
  data: SubscriberDetail;
}

export function SubscriberDetailPanel({ data }: Props) {
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-6">
        <div className="flex flex-col gap-2">
          <div className="text-2xl font-semibold">{data.appUserId}</div>
          <div className="flex flex-wrap gap-4 text-xs text-default-500">
            <span>
              First seen: {new Date(data.firstSeenAt).toLocaleString()}
            </span>
            <span>
              Last seen: {new Date(data.lastSeenAt).toLocaleString()}
            </span>
            {data.deletedAt && (
              <span className="text-danger-500">
                Deleted: {new Date(data.deletedAt).toLocaleString()}
              </span>
            )}
            {data.mergedInto && (
              <span>Merged into: {data.mergedInto}</span>
            )}
          </div>
        </div>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-default-500">
            Attributes
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-default-100 p-3 text-xs">
            {JSON.stringify(data.attributes, null, 2)}
          </pre>
        </details>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold">Access</h2>
        <AccessTable rows={data.access} />
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold">Purchases</h2>
        <PurchasesTable rows={data.purchases} />
      </Card>

      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Credits</h2>
          <span className="text-sm text-default-500">
            Balance: <b className="text-default-900">{data.creditBalance}</b>
          </span>
        </div>
        <CreditLedgerTable rows={data.creditLedger} />
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-lg font-semibold">Experiments</h2>
        <AssignmentsList rows={data.assignments} />
      </Card>
    </div>
  );
}
