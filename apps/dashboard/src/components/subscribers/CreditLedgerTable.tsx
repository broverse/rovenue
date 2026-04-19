import type { SubscriberCreditLedgerRow } from "@rovenue/shared";

interface Props {
  rows: SubscriberCreditLedgerRow[];
}

export function CreditLedgerTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-default-300 p-6 text-center text-sm text-default-500">
        No credit activity.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-default-500">
          <tr className="border-b border-default-200">
            <th className="py-2 pr-4">When</th>
            <th className="py-2 pr-4">Type</th>
            <th className="py-2 pr-4">Amount</th>
            <th className="py-2 pr-4">Balance</th>
            <th className="py-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-default-100">
              <td className="py-2 pr-4">
                {new Date(r.createdAt).toLocaleString()}
              </td>
              <td className="py-2 pr-4">{r.type}</td>
              <td className="py-2 pr-4 font-mono">{r.amount}</td>
              <td className="py-2 pr-4 font-mono">{r.balance}</td>
              <td className="py-2 text-default-600">{r.description ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
