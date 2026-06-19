import { useTranslation } from "react-i18next";
import { Archive, Pencil } from "lucide-react";
import type { VirtualCurrency } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Chip } from "../../ui/chip";

interface Props {
  currencies: ReadonlyArray<VirtualCurrency>;
  onRename: (currency: VirtualCurrency) => void;
  onArchive: (currency: VirtualCurrency) => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function CurrenciesTable({ currencies, onRename, onArchive }: Props) {
  const { t } = useTranslation();

  return (
    <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-rv-divider text-[11px] uppercase tracking-wider text-rv-mute-500">
            <th className="px-4 py-2.5 font-medium">{t("currencies.cols.code")}</th>
            <th className="px-4 py-2.5 font-medium">{t("currencies.cols.name")}</th>
            <th className="px-4 py-2.5 font-medium">{t("currencies.cols.status")}</th>
            <th className="hidden px-4 py-2.5 font-medium sm:table-cell">
              {t("currencies.cols.created")}
            </th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {currencies.map((currency) => {
            const archived = currency.archivedAt !== null;
            return (
              <tr
                key={currency.id}
                className="border-b border-rv-divider last:border-0"
              >
                <td className="px-4 py-3">
                  <code className="font-rv-mono text-[12.5px] text-foreground">
                    {currency.code}
                  </code>
                </td>
                <td className="px-4 py-3 text-foreground">{currency.name}</td>
                <td className="px-4 py-3">
                  <Chip tone={archived ? "default" : "success"}>
                    {archived
                      ? t("currencies.status.archived")
                      : t("currencies.status.active")}
                  </Chip>
                </td>
                <td className="hidden px-4 py-3 text-rv-mute-500 sm:table-cell">
                  {formatDate(currency.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {!archived && (
                      <>
                        <Button
                          variant="light"
                          size="sm"
                          onClick={() => onRename(currency)}
                          aria-label={t("currencies.actions.rename")}
                        >
                          <Pencil size={13} />
                        </Button>
                        <Button
                          variant="light"
                          size="sm"
                          className="text-rv-danger"
                          onClick={() => onArchive(currency)}
                          aria-label={t("currencies.actions.archive")}
                        >
                          <Archive size={13} />
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
