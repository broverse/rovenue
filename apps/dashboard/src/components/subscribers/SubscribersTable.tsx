import { Chip } from "@heroui/react";
import { Link } from "@tanstack/react-router";
import type { SubscriberListItem } from "@rovenue/shared";

interface Props {
  projectId: string;
  rows: SubscriberListItem[];
}

export function SubscribersTable({ projectId, rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-default-300 p-12 text-center text-default-500">
        No subscribers
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-default-500">
          <tr className="border-b border-default-200">
            <th className="py-2 pr-4">App user id</th>
            <th className="py-2 pr-4">Last seen</th>
            <th className="py-2 pr-4">Purchases</th>
            <th className="py-2">Active access</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="border-b border-default-100">
              <td className="py-2 pr-4">
                <Link
                  to="/projects/$projectId/subscribers/$id"
                  params={{ projectId, id: s.id }}
                  className="text-primary"
                >
                  {s.appUserId}
                </Link>
              </td>
              <td className="py-2 pr-4">
                {new Date(s.lastSeenAt).toLocaleString()}
              </td>
              <td className="py-2 pr-4">{s.purchaseCount}</td>
              <td className="py-2">
                <div className="flex flex-wrap gap-1">
                  {s.activeEntitlementKeys.length === 0 && (
                    <span className="text-default-400">—</span>
                  )}
                  {s.activeEntitlementKeys.map((k) => (
                    <Chip key={k} size="sm" color="success">
                      {k}
                    </Chip>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
