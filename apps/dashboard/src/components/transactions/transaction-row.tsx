import { useTranslation } from "react-i18next";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../lib/cn";
import { avatarColorFor, avatarInitialsFor, formatSignedMoney } from "./format";
import { StoreInlineBadge } from "./store-badge";
import { TxIcon } from "./tx-icon";
import { TxStatusChip } from "./tx-status-chip";
import type { Transaction } from "./types";

type Props = {
  tx: Transaction;
  selected: boolean;
  active: boolean;
  onToggleSelected: () => void;
  onOpen: () => void;
};

/** A single transactions table row — clickable to open the inspector. */
export function TransactionRow({ tx, selected, active, onToggleSelected, onOpen }: Props) {
  const { t } = useTranslation();
  return (
    <tr
      onClick={onOpen}
      className={cn(
        "group cursor-pointer border-b border-white/[0.04] transition hover:bg-rv-c2",
        active &&
          "bg-rv-accent-500/[0.08] [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-rv-accent-500)]",
      )}
    >
      <td className="w-7 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onChange={onToggleSelected}
          ariaLabel={t("transactions.table.selectRowAria", { id: tx.id })}
        />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <TxIcon type={tx.type} />
          <div className="min-w-0">
            <div className="font-rv-mono text-[12px] font-medium text-foreground">{tx.id}</div>
            <div className="font-rv-mono text-[10px] capitalize text-rv-mute-500">
              {t(`transactions.type.${tx.type}`)}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="flex size-5 shrink-0 items-center justify-center rounded-full font-rv-mono text-[8px] font-semibold text-white"
            style={{ background: avatarColorFor(tx.user) }}
          >
            {avatarInitialsFor(tx.user)}
          </span>
          <div className="min-w-0">
            <div className="truncate font-rv-mono text-[12px] text-foreground">{tx.user}</div>
            <div className="font-rv-mono text-[10px] text-rv-mute-500">{tx.sub}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 font-rv-mono text-[12px] text-foreground">{tx.product}</td>
      <td className="px-3 py-2.5">
        <StoreInlineBadge store={tx.store} />
      </td>
      <td
        className={cn(
          "whitespace-nowrap px-3 py-2.5 text-right font-rv-mono text-[13px] tabular-nums",
          tx.gross === 0 && "text-rv-mute-500",
          tx.gross < 0 && "text-rv-danger",
        )}
      >
        {formatSignedMoney(tx.gross)}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right font-rv-mono text-[11px] tabular-nums text-rv-mute-500">
        {formatSignedMoney(tx.fee)}
      </td>
      <td
        className={cn(
          "whitespace-nowrap px-3 py-2.5 text-right font-rv-mono text-[13px] tabular-nums",
          tx.net === 0 && "text-rv-mute-500",
          tx.net < 0 && "text-rv-danger",
        )}
      >
        {formatSignedMoney(tx.net)}
      </td>
      <td className="px-3 py-2.5">
        <TxStatusChip status={tx.status} />
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right font-rv-mono text-[11px] text-rv-mute-600">
        {tx.at}
      </td>
    </tr>
  );
}
