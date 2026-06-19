import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { QuerySchemaColumn } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { useQuerySchema } from "../../lib/hooks/useProjectQueries";

// Operators offered in the filter rows. `LIKE` is handy for String columns;
// the rest cover the common numeric / equality cases.
const OPERATORS = ["=", "!=", ">", "<", ">=", "<=", "LIKE"] as const;
type Operator = (typeof OPERATORS)[number];

type Filter = {
  id: number;
  column: string;
  op: Operator;
  value: string;
};

type Props = {
  projectId: string;
  /** Emits the generated SQL whenever the builder state changes. */
  onChange: (sql: string) => void;
};

let filterSeq = 0;
const newFilter = (column: string): Filter => ({
  id: ++filterSeq,
  column,
  op: "=",
  value: "",
});

/** ClickHouse numeric column types take an unquoted literal. */
function isNumericType(type: string): boolean {
  return /\b(u?int\d*|float\d*|decimal)/i.test(type);
}

/** Render a filter as a SQL predicate, quoting non-numeric values. */
function predicate(filter: Filter, columns: QuerySchemaColumn[]): string | null {
  if (!filter.column || filter.value.trim() === "") return null;
  const col = columns.find((c) => c.name === filter.column);
  const numeric = col ? isNumericType(col.type) : false;
  const raw = filter.value.trim();
  // Single-quote (and escape) anything that isn't a bare number.
  const literal =
    numeric && /^-?\d+(\.\d+)?$/.test(raw)
      ? raw
      : `'${raw.replace(/'/g, "''")}'`;
  return `${filter.column} ${filter.op} ${literal}`;
}

function buildSql(
  table: string,
  filters: Filter[],
  columns: QuerySchemaColumn[],
  limit: number,
): string {
  if (!table) return "";
  const lines = ["SELECT *", `FROM ${table}`];
  const predicates = filters
    .map((f) => predicate(f, columns))
    .filter((p): p is string => p !== null);
  if (predicates.length > 0) {
    lines.push(`WHERE ${predicates.join("\n  AND ")}`);
  }
  lines.push(`LIMIT ${limit}`);
  return lines.join("\n");
}

/**
 * Minimal point-and-click query builder: pick a table, add WHERE filters,
 * set a LIMIT. Generates SQL live and pushes it up via `onChange` so Run /
 * Save operate on the same body the SQL editor would. Project isolation is
 * injected server-side, so no projectId predicate is needed here.
 */
export function VisualBuilder({ projectId, onChange }: Props) {
  const { t } = useTranslation();
  const schema = useQuerySchema(projectId);
  const tables = schema.data?.tables ?? [];

  const [table, setTable] = useState("");
  const [filters, setFilters] = useState<Filter[]>([]);
  const [limit, setLimit] = useState(100);

  const columns = useMemo(
    () => tables.find((tbl) => tbl.name === table)?.columns ?? [],
    [tables, table],
  );

  const sql = useMemo(
    () => buildSql(table, filters, columns, limit),
    [table, filters, columns, limit],
  );

  // Push generated SQL up whenever it changes.
  useEffect(() => {
    if (sql) onChange(sql);
  }, [sql, onChange]);

  const updateFilter = (id: number, patch: Partial<Filter>) =>
    setFilters((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    );

  if (schema.isLoading) {
    return (
      <div className="flex min-h-[280px] items-center justify-center bg-rv-bg px-4 text-center text-[12px] text-rv-mute-500">
        {t("queries.builder.loading")}
      </div>
    );
  }

  if (schema.error || tables.length === 0) {
    return (
      <div className="flex min-h-[280px] items-center justify-center bg-rv-bg px-4 text-center text-[12px] text-rv-mute-500">
        {t("queries.builder.noSchema")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 bg-rv-bg px-4 py-4">
      {/* Table picker */}
      <div>
        <label className="block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("queries.builder.table")}
        </label>
        <NativeSelect
          value={table}
          onChange={(e) => {
            setTable(e.target.value);
            setFilters([]);
          }}
          className="mt-1.5 max-w-sm font-rv-mono text-[12px]"
        >
          <option value="" disabled>
            {t("queries.builder.tablePlaceholder")}
          </option>
          {tables.map((tbl) => (
            <option key={tbl.name} value={tbl.name}>
              {tbl.name}
            </option>
          ))}
        </NativeSelect>
      </div>

      {/* Filters */}
      <div>
        <div className="flex items-center justify-between">
          <label className="block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t("queries.builder.filters")}
          </label>
          <Button
            variant="light"
            size="sm"
            className="h-[24px]"
            disabled={!table}
            onClick={() =>
              setFilters((prev) => [
                ...prev,
                newFilter(columns[0]?.name ?? ""),
              ])
            }
          >
            <Plus size={12} />
            {t("queries.builder.addFilter")}
          </Button>
        </div>

        {filters.length === 0 ? (
          <p className="mt-1.5 text-[12px] text-rv-mute-500">
            {t("queries.builder.noFilters")}
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {filters.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center gap-2">
                <NativeSelect
                  value={f.column}
                  onChange={(e) => updateFilter(f.id, { column: e.target.value })}
                  className="w-[180px] font-rv-mono text-[12px]"
                >
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  value={f.op}
                  onChange={(e) =>
                    updateFilter(f.id, { op: e.target.value as Operator })
                  }
                  className="w-[88px] font-rv-mono text-[12px]"
                >
                  {OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </NativeSelect>
                <Input
                  mono
                  value={f.value}
                  onChange={(e) => updateFilter(f.id, { value: e.target.value })}
                  placeholder={t("queries.builder.valuePlaceholder")}
                  className="w-[200px]"
                />
                <button
                  type="button"
                  aria-label={t("queries.builder.removeFilter")}
                  onClick={() =>
                    setFilters((prev) => prev.filter((x) => x.id !== f.id))
                  }
                  className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Limit */}
      <div>
        <label className="block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("queries.builder.limit")}
        </label>
        <Input
          type="number"
          min={1}
          max={5000}
          value={limit}
          onChange={(e) =>
            setLimit(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))
          }
          className="mt-1.5 w-[120px]"
        />
      </div>

      {/* Generated SQL preview */}
      <div>
        <label className="block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("queries.builder.generated")}
        </label>
        <pre className="mt-1.5 overflow-x-auto rounded-md border border-rv-divider bg-rv-c1 px-3 py-2 font-rv-mono text-[12px] text-rv-mute-700">
          {sql || t("queries.builder.generatedEmpty")}
        </pre>
      </div>
    </div>
  );
}
