import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { StatusChip } from "./status-chip";
import { OutcomeChip } from "./outcome-chip";
import type { RefundShieldResponseRow } from "../../lib/hooks/useRefundShield";

export interface ResponsesTableProps {
  projectId: string;
  rows: ReadonlyArray<RefundShieldResponseRow>;
}

export function ResponsesTable({ projectId, rows }: ResponsesTableProps) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-rv-divider bg-rv-c1 px-4 py-8 text-center text-[12px] text-rv-mute-500">
        {t("refundShield.responses.empty")}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-rv-divider bg-rv-c1">
      <table className="w-full text-left text-[12px]">
        <thead className="border-b border-rv-divider bg-rv-c2/40 text-[10px] uppercase tracking-wider text-rv-mute-500">
          <tr>
            <Th>{t("refundShield.responses.columns.detectedAt")}</Th>
            <Th>{t("refundShield.responses.columns.status")}</Th>
            <Th>{t("refundShield.responses.columns.outcome")}</Th>
            <Th>{t("refundShield.responses.columns.subscriber")}</Th>
            <Th>
              {t("refundShield.responses.columns.originalTransactionId")}
            </Th>
            <Th>{t("refundShield.responses.columns.retries")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-rv-divider last:border-b-0 hover:bg-rv-c2/40"
            >
              <Td>
                <Link
                  to="/projects/$projectId/refund-shield/responses/$rid"
                  params={{ projectId, rid: r.id }}
                  className="font-rv-mono text-rv-mute-700 hover:text-rv-accent-500"
                >
                  {new Date(r.detectedAt).toLocaleString()}
                </Link>
              </Td>
              <Td>
                <StatusChip status={r.status} />
              </Td>
              <Td>
                <OutcomeChip outcome={r.outcome} />
              </Td>
              <Td>
                {r.subscriberId ? (
                  <Link
                    to="/projects/$projectId/subscribers/$id"
                    params={{ projectId, id: r.subscriberId }}
                    className="font-rv-mono text-rv-mute-700 hover:text-rv-accent-500"
                  >
                    {r.subscriberId.slice(0, 8)}…
                  </Link>
                ) : (
                  <span className="text-rv-mute-500">—</span>
                )}
              </Td>
              <Td>
                <span className="font-rv-mono text-rv-mute-700">
                  {r.appleOriginalTransactionId}
                </span>
              </Td>
              <Td>
                <span className="font-rv-mono tabular-nums text-rv-mute-700">
                  {r.retryCount}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-middle">{children}</td>;
}
