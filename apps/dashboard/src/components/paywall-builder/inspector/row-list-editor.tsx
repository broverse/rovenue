import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

// =============================================================
// RowListEditor — a controlled add/remove/reorder list over authored
// rows. Unlike BindingTab's package checkboxes (toggling membership of a
// fixed set), these rows are created, ordered and deleted by the author,
// so the component owns none of that shape — Task 3 supplies `renderRow`
// per node type (featureList/socialProof/timeline) and everything it
// needs to edit a row is the `patch` callback handed to it here.
//
// `key={index}` is intentional: rows have no stable identity, and
// reordering is an explicit user action, so index IS the identity being
// manipulated.
// =============================================================

const ICON_BUTTON_CLASS =
  "flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30";

const REMOVE_BUTTON_CLASS =
  "flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-danger/15 hover:text-rv-danger";

const ROW_ICON_SIZE = 11;

type RowListEditorProps<T> = {
  rows: readonly T[];
  onChange: (rows: T[]) => void;
  /** Builds the row appended by the add button. */
  newRow: () => T;
  addLabel: string;
  renderRow: (row: T, index: number, patch: (fields: Partial<T>) => void) => ReactNode;
  /** Disables the add button once `rows.length` reaches this many — some row
   *  lists are schema-capped (e.g. `FOOTER_LINKS_MAX`). Omitted for the
   *  lists with no upper bound (featureList/timeline rows). */
  maxRows?: number;
};

export function RowListEditor<T>({
  rows,
  onChange,
  newRow,
  addLabel,
  renderRow,
  maxRows,
}: RowListEditorProps<T>) {
  const { t } = useTranslation();
  const atMax = maxRows !== undefined && rows.length >= maxRows;
  const replace = (index: number, row: T) => onChange(rows.map((r, i) => (i === index ? row : r)));

  const move = (index: number, delta: number) => {
    const next = rows.slice();
    const [row] = next.splice(index, 1);
    next.splice(index + delta, 0, row as T);
    onChange(next);
  };

  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-start gap-1.5 rounded-md border border-rv-divider bg-rv-c2 p-2">
          <div className="min-w-0 flex-1">{renderRow(row, index, (fields) => replace(index, { ...row, ...fields }))}</div>
          <div className="flex flex-shrink-0 items-center gap-0.5">
            <button
              type="button"
              title={t("paywalls.builder.rowList.moveUp", "Move up row {{index}}", { index: index + 1 })}
              disabled={index === 0}
              onClick={() => move(index, -1)}
              className={ICON_BUTTON_CLASS}
            >
              <ChevronUp size={ROW_ICON_SIZE} />
            </button>
            <button
              type="button"
              title={t("paywalls.builder.rowList.moveDown", "Move down row {{index}}", { index: index + 1 })}
              disabled={index === rows.length - 1}
              onClick={() => move(index, 1)}
              className={ICON_BUTTON_CLASS}
            >
              <ChevronDown size={ROW_ICON_SIZE} />
            </button>
            <button
              type="button"
              title={t("paywalls.builder.rowList.remove", "Remove row {{index}}", { index: index + 1 })}
              onClick={() => remove(index)}
              className={REMOVE_BUTTON_CLASS}
            >
              <Trash2 size={ROW_ICON_SIZE} />
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, newRow()])}
        disabled={atMax}
        className="inline-flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-rv-divider bg-rv-c2 px-2 text-[11px] text-rv-mute-600 transition hover:border-rv-accent-500 hover:text-rv-accent-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-rv-divider disabled:hover:text-rv-mute-600"
      >
        <Plus size={ROW_ICON_SIZE} />
        {addLabel}
      </button>
    </div>
  );
}
