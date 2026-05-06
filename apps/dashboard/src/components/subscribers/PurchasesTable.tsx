import { useTranslation } from "react-i18next";
import type { SubscriberPurchase } from "@rovenue/shared";

interface Props {
  rows: SubscriberPurchase[];
}

export function PurchasesTable({ rows }: Props) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-default-300 p-6 text-center text-sm text-default-500">
        {t("subscribers.purchases.empty")}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-default-500">
          <tr className="border-b border-default-200">
            <th className="py-2 pr-4">{t("subscribers.purchases.product")}</th>
            <th className="py-2 pr-4">{t("subscribers.purchases.store")}</th>
            <th className="py-2 pr-4">{t("subscribers.purchases.status")}</th>
            <th className="py-2 pr-4">{t("subscribers.purchases.price")}</th>
            <th className="py-2 pr-4">{t("subscribers.purchases.purchased")}</th>
            <th className="py-2">{t("subscribers.purchases.expires")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-b border-default-100">
              <td className="py-2 pr-4 font-semibold">{p.productIdentifier}</td>
              <td className="py-2 pr-4">{p.store}</td>
              <td className="py-2 pr-4">{p.status}</td>
              <td className="py-2 pr-4">
                {p.priceAmount && p.priceCurrency
                  ? `${p.priceAmount} ${p.priceCurrency}`
                  : "—"}
              </td>
              <td className="py-2 pr-4">
                {new Date(p.purchaseDate).toLocaleString()}
              </td>
              <td className="py-2">
                {p.expiresDate
                  ? new Date(p.expiresDate).toLocaleString()
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
