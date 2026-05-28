import { useMemo } from "react";
import { Chip } from "@heroui/react";
import { useTranslation } from "react-i18next";
import type { SubscriberAccessRow } from "@rovenue/shared";
import { useProjectAccess } from "../../lib/hooks/useProjectAccess";

interface Props {
  projectId: string;
  rows: SubscriberAccessRow[];
}

export function AccessTable({ projectId, rows }: Props) {
  const { t } = useTranslation();
  const accessQuery = useProjectAccess(projectId);
  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of accessQuery.data?.rows ?? []) m.set(r.id, r.displayName);
    return m;
  }, [accessQuery.data]);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-default-300 p-6 text-center text-sm text-default-500">
        {t("subscribers.access.empty")}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-default-500">
          <tr className="border-b border-default-200">
            <th className="py-2 pr-4">{t("subscribers.access.access")}</th>
            <th className="py-2 pr-4">{t("subscribers.access.status")}</th>
            <th className="py-2 pr-4">{t("subscribers.access.expires")}</th>
            <th className="py-2 pr-4">{t("subscribers.access.store")}</th>
            <th className="py-2">{t("subscribers.access.purchase")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.accessId}-${r.purchaseId}`}
              className="border-b border-default-100"
            >
              <td className="py-2 pr-4">
                <Chip size="sm" color="success">
                  <span className="font-rv-mono">
                    {labelById.get(r.accessId) ?? r.accessId}
                  </span>
                </Chip>
              </td>
              <td className="py-2 pr-4">{r.isActive ? t("common.active") : t("common.inactive")}</td>
              <td className="py-2 pr-4">
                {r.expiresDate
                  ? new Date(r.expiresDate).toLocaleString()
                  : t("common.never")}
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
