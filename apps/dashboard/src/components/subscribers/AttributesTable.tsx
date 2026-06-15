import { Chip } from "@heroui/react";
import { useTranslation } from "react-i18next";
import type {
  AttributeEntry,
  AttributeSource,
  SubscriberAttributes,
} from "@rovenue/shared";

const SOURCE_COLOR: Record<
  AttributeSource,
  "accent" | "warning" | "success" | "default"
> = {
  sdk: "accent",
  server: "warning",
  dashboard: "success",
  legacy: "default",
};

function formatUpdatedAt(iso: string): string {
  // Legacy epoch sentinel renders as "—"
  if (iso === "1970-01-01T00:00:00.000Z") return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function AttributesTable({
  attributes,
}: {
  attributes: SubscriberAttributes;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(attributes) as Array<[string, AttributeEntry]>;
  entries.sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-default-300 p-6 text-center text-sm text-default-500">
        {t("subscribers.detail.attributesTable.empty")}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-default-500">
          <tr className="border-b border-default-200">
            <th className="py-2 pr-4">
              {t("subscribers.detail.attributesTable.key")}
            </th>
            <th className="py-2 pr-4">
              {t("subscribers.detail.attributesTable.value")}
            </th>
            <th className="py-2 pr-4">
              {t("subscribers.detail.attributesTable.source")}
            </th>
            <th className="py-2">
              {t("subscribers.detail.attributesTable.updatedAt")}
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, entry]) => (
            <tr key={key} className="border-b border-default-100">
              <td className="py-2 pr-4 font-mono text-xs">{key}</td>
              <td className="py-2 pr-4 break-all">{entry.value}</td>
              <td className="py-2 pr-4">
                <Chip
                  size="sm"
                  variant="soft"
                  color={SOURCE_COLOR[entry.source] ?? "default"}
                >
                  {entry.source}
                </Chip>
              </td>
              <td className="py-2 text-default-500">
                {formatUpdatedAt(entry.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
