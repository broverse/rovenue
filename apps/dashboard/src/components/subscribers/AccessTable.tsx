import { Chip } from "@heroui/react";
import type { SubscriberAccessRow } from "@rovenue/shared";

interface Props {
  rows: SubscriberAccessRow[];
}

export function AccessTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-default-300 p-6 text-center text-sm text-default-500">
        No active access.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-default-500">
          <tr className="border-b border-default-200">
            <th className="py-2 pr-4">Entitlement</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Expires</th>
            <th className="py-2 pr-4">Store</th>
            <th className="py-2">Purchase</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.entitlementKey}-${r.purchaseId}`}
              className="border-b border-default-100"
            >
              <td className="py-2 pr-4">
                <Chip size="sm" color="success">
                  {r.entitlementKey}
                </Chip>
              </td>
              <td className="py-2 pr-4">{r.isActive ? "Active" : "Inactive"}</td>
              <td className="py-2 pr-4">
                {r.expiresDate
                  ? new Date(r.expiresDate).toLocaleString()
                  : "Never"}
              </td>
              <td className="py-2 pr-4">{r.store}</td>
              <td className="py-2 font-mono text-xs text-default-500">
                {r.purchaseId}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
