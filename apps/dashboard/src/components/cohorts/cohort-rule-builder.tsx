import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type {
  CohortFilter,
  CohortFilterField,
  CohortOperator,
  CohortRule,
} from "@rovenue/shared";
import { Button } from "../../ui/button";
import {
  ALL_FIELDS,
  allowedOps,
  defaultFilter,
  defaultValueForOp,
} from "./rule-codec";

type Props = {
  rule: CohortRule;
  onChange: (next: CohortRule) => void;
};

const STORE_OPTIONS = ["apple", "google", "stripe"] as const;
const PURCHASE_TYPE_OPTIONS = [
  "subscription",
  "consumable",
  "non_consumable",
] as const;

export function CohortRuleBuilder({ rule, onChange }: Props) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);

  function setMatch(match: "all" | "any") {
    onChange({ ...rule, match });
  }

  function addFilter(field: CohortFilterField) {
    onChange({ ...rule, filters: [...rule.filters, defaultFilter(field)] });
    setAdding(false);
  }

  function updateFilter(idx: number, next: CohortFilter) {
    const filters = rule.filters.slice();
    filters[idx] = next;
    onChange({ ...rule, filters });
  }

  function removeFilter(idx: number) {
    const filters = rule.filters.filter((_, i) => i !== idx);
    onChange({ ...rule, filters });
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-2 text-[12px] text-rv-mute-600"
        data-match={rule.match}
      >
        <span>
          {t("cohorts.form.rules.matchPrefix")}{" "}
          {t(`cohorts.form.rules.match.${rule.match}`)}
        </span>
        <select
          value={rule.match}
          onChange={(e) => setMatch(e.target.value as "all" | "any")}
          aria-label={`${t("cohorts.form.rules.matchPrefix")} ${t(`cohorts.form.rules.match.${rule.match}`)}`}
          className="h-7 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground"
        >
          <option value="all">{t("cohorts.form.rules.match.all")}</option>
          <option value="any">{t("cohorts.form.rules.match.any")}</option>
        </select>
        <span>{t("cohorts.form.rules.matchSuffix")}</span>
      </div>

      {rule.filters.length === 0 && (
        <p className="m-0 text-[12px] text-rv-mute-500">
          {t("cohorts.form.rules.emptyHint")}
        </p>
      )}

      {rule.filters.map((f, idx) => (
        <FilterRow
          key={idx}
          filter={f}
          onChange={(next) => updateFilter(idx, next)}
          onRemove={() => removeFilter(idx)}
        />
      ))}

      <div className="relative">
        <Button
          type="button"
          variant="flat"
          size="sm"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus size={12} />
          {t("cohorts.form.rules.addFilter")}
        </Button>
        {adding && (
          <div className="absolute z-10 mt-1 w-44 rounded-md border border-rv-divider bg-rv-c1 p-1 shadow-lg">
            {ALL_FIELDS.map((field) => (
              <button
                key={field}
                type="button"
                onClick={() => addFilter(field)}
                className="block w-full cursor-pointer rounded px-2 py-1 text-left text-[12px] text-foreground transition hover:bg-rv-c2"
              >
                {t(`cohorts.form.rules.field.${field}`)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterRow({
  filter,
  onChange,
  onRemove,
}: {
  filter: CohortFilter;
  onChange: (next: CohortFilter) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const ops = allowedOps(filter.field);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2 py-2">
      <select
        value={filter.field}
        onChange={(e) => {
          const field = e.target.value as CohortFilterField;
          const nextOp = allowedOps(field)[0]!;
          onChange({ field, op: nextOp, value: defaultValueForOp(nextOp) });
        }}
        className="h-7 rounded border border-rv-divider bg-rv-c1 px-2 text-[12px] text-foreground"
      >
        {ALL_FIELDS.map((f) => (
          <option key={f} value={f}>
            {t(`cohorts.form.rules.field.${f}`)}
          </option>
        ))}
      </select>

      <select
        value={filter.op}
        onChange={(e) => {
          const op = e.target.value as CohortOperator;
          onChange({ ...filter, op, value: defaultValueForOp(op) });
        }}
        className="h-7 rounded border border-rv-divider bg-rv-c1 px-2 text-[12px] text-foreground"
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {t(`cohorts.form.rules.op.${op}`)}
          </option>
        ))}
      </select>

      <ValueEditor filter={filter} onChange={onChange} />

      <button
        type="button"
        aria-label={t("cohorts.form.rules.removeFilter")}
        onClick={onRemove}
        className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ValueEditor({
  filter,
  onChange,
}: {
  filter: CohortFilter;
  onChange: (next: CohortFilter) => void;
}) {
  const { t } = useTranslation();

  if (filter.op === "in") {
    const values = Array.isArray(filter.value) ? filter.value : [];
    return (
      <ChipInput
        values={values}
        placeholder={t(`cohorts.form.rules.placeholder.${filter.field}`)}
        options={
          filter.field === "store"
            ? STORE_OPTIONS
            : filter.field === "purchaseType"
              ? PURCHASE_TYPE_OPTIONS
              : undefined
        }
        normalise={
          filter.field === "country" ? (v) => v.trim().toUpperCase() : undefined
        }
        onChange={(next) => onChange({ ...filter, value: next })}
      />
    );
  }

  if (filter.op === "eq") {
    return (
      <input
        type="text"
        value={typeof filter.value === "string" ? filter.value : ""}
        placeholder={t(`cohorts.form.rules.placeholder.${filter.field}`)}
        onChange={(e) => onChange({ ...filter, value: e.target.value })}
        className="h-7 min-w-[120px] flex-1 rounded border border-rv-divider bg-rv-c1 px-2 text-[12px] text-foreground"
      />
    );
  }

  if (filter.op === "gte" || filter.op === "lte") {
    const v = typeof filter.value === "string" ? filter.value : "";
    return (
      <input
        type="datetime-local"
        value={isoToLocal(v)}
        onChange={(e) =>
          onChange({ ...filter, value: localToIso(e.target.value) })
        }
        className="h-7 rounded border border-rv-divider bg-rv-c1 px-2 text-[12px] text-foreground"
      />
    );
  }

  return null;
}

function ChipInput({
  values,
  placeholder,
  options,
  normalise,
  onChange,
}: {
  values: string[];
  placeholder: string;
  options?: ReadonlyArray<string>;
  normalise?: (v: string) => string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const v = normalise ? normalise(trimmed) : trimmed;
    if (values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  }

  return (
    <div className="flex min-w-[180px] flex-1 flex-wrap items-center gap-1 rounded border border-rv-divider bg-rv-c1 px-1.5 py-1">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded bg-rv-c2 px-1.5 py-0.5 font-rv-mono text-[11px] text-foreground"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="cursor-pointer text-rv-mute-500 hover:text-foreground"
            aria-label={`Remove ${v}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        list={options ? `chip-${placeholder}` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        className="min-w-[80px] flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
      />
      {options && (
        <datalist id={`chip-${placeholder}`}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </div>
  );
}

function isoToLocal(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function localToIso(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}
