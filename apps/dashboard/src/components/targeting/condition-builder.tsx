import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ListBox } from "@heroui/react";
import {
  Check,
  ChevronDown,
  Globe2,
  KeyRound,
  Layers,
  Package,
  Plus,
  Smartphone,
  Tag,
  Trash2,
} from "lucide-react";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { cn } from "../../lib/cn";
import {
  makeCondition,
  type CompareOp,
  type ConditionKind,
  type DraftCondition,
  type ListOp,
} from "./sift-codec";

const CONDITION_TYPES: ReadonlyArray<{
  kind: ConditionKind;
  labelKey: string;
  icon: ReactNode;
}> = [
  {
    kind: "customAttribute",
    labelKey: "targeting.conditions.types.customAttribute",
    icon: <KeyRound size={11} />,
  },
  {
    kind: "country",
    labelKey: "targeting.conditions.types.country",
    icon: <Globe2 size={11} />,
  },
  {
    kind: "app",
    labelKey: "targeting.conditions.types.app",
    icon: <Package size={11} />,
  },
  {
    kind: "appVersion",
    labelKey: "targeting.conditions.types.appVersion",
    icon: <Tag size={11} />,
  },
  {
    kind: "platform",
    labelKey: "targeting.conditions.types.platform",
    icon: <Smartphone size={11} />,
  },
  {
    kind: "sdkVersion",
    labelKey: "targeting.conditions.types.sdkVersion",
    icon: <Layers size={11} />,
  },
];

const LIST_OPS: ReadonlyArray<{ value: ListOp; labelKey: string }> = [
  { value: "$in", labelKey: "targeting.conditions.ops.in" },
  { value: "$nin", labelKey: "targeting.conditions.ops.notIn" },
];

const COMPARE_OPS: ReadonlyArray<{ value: CompareOp; labelKey: string }> = [
  { value: "$eq", labelKey: "targeting.conditions.ops.eq" },
  { value: "$ne", labelKey: "targeting.conditions.ops.ne" },
  { value: "$gte", labelKey: "targeting.conditions.ops.gte" },
  { value: "$gt", labelKey: "targeting.conditions.ops.gt" },
  { value: "$lte", labelKey: "targeting.conditions.ops.lte" },
  { value: "$lt", labelKey: "targeting.conditions.ops.lt" },
];

const PLATFORM_VALUES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "ios", label: "iOS" },
  { value: "android", label: "Android" },
  { value: "web", label: "Web" },
];

export interface ConditionListProps {
  conditions: ReadonlyArray<DraftCondition>;
  onChange: (next: DraftCondition[]) => void;
  disabled?: boolean;
}

export function ConditionList({
  conditions,
  onChange,
  disabled,
}: ConditionListProps) {
  const { t } = useTranslation();

  const updateAt = (idx: number, patch: Partial<DraftCondition>) =>
    onChange(
      conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    );

  const removeAt = (idx: number) =>
    onChange(conditions.filter((_, i) => i !== idx));

  const append = (kind: ConditionKind) =>
    onChange([...conditions, makeCondition(kind)]);

  return (
    <div className="flex flex-col gap-2">
      {conditions.length === 0 && (
        <span className="text-[11px] italic text-rv-mute-500">
          {t("targeting.conditions.empty")}
        </span>
      )}
      {conditions.map((c, idx) => (
        <ConditionRow
          key={idx}
          condition={c}
          onChange={(patch) => updateAt(idx, patch)}
          onRemove={() => removeAt(idx)}
          disabled={disabled}
        />
      ))}
      {!disabled && <ConditionMenu onPick={append} />}
    </div>
  );
}

function ConditionMenu({ onPick }: { onPick: (kind: ConditionKind) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-rv-divider-strong bg-transparent px-3 py-1.5 text-[11px] font-medium text-rv-mute-600 transition hover:border-rv-accent-500 hover:bg-rv-accent-500/5 hover:text-rv-accent-500"
      >
        <Plus size={11} />
        {t("targeting.conditions.add")}
        <ChevronDown size={11} className="text-rv-mute-500" />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full z-20 mt-1 w-[220px] overflow-hidden rounded-md border border-rv-divider bg-rv-c1 shadow-lg">
            {CONDITION_TYPES.map((opt) => (
              <button
                key={opt.kind}
                type="button"
                onClick={() => {
                  onPick(opt.kind);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground transition hover:bg-rv-c3"
              >
                <span className="text-rv-mute-500">{opt.icon}</span>
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OpSelect({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; labelKey: string }>;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Select
      aria-label={ariaLabel}
      isDisabled={disabled}
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
    >
      <Select.Trigger className="inline-flex h-7 w-auto min-w-[52px] cursor-pointer items-center justify-between gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground outline-none transition hover:bg-rv-c3 data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-rv-accent-500 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60">
        <Select.Value className="truncate" />
        <ChevronDown size={12} className="text-rv-mute-500" aria-hidden />
      </Select.Trigger>
      <Select.Popover
        placement="bottom start"
        className="min-w-[var(--trigger-width)] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1 shadow-[0_18px_44px_rgba(0,0,0,0.5)]"
      >
        <ListBox
          aria-label={ariaLabel}
          className="flex max-h-[240px] flex-col gap-0.5 overflow-auto outline-none"
        >
          {options.map((op) => (
            <ListBox.Item
              key={op.value}
              id={op.value}
              textValue={t(op.labelKey)}
              className="flex cursor-pointer items-center whitespace-nowrap rounded px-2 py-1.5 text-[12px] text-foreground outline-none data-[hovered=true]:bg-rv-c2 data-[focused=true]:bg-rv-c2 data-[selected=true]:bg-rv-c2"
            >
              {t(op.labelKey)}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
  disabled,
}: {
  condition: DraftCondition;
  onChange: (patch: Partial<DraftCondition>) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const meta = CONDITION_TYPES.find((c) => c.kind === condition.kind)!;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-rv-divider bg-rv-c1 px-2.5 py-2">
      <span className="inline-flex items-center gap-1 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
        {meta.icon}
        {t(meta.labelKey)}
      </span>

      {condition.kind === "customAttribute" && (
        <>
          <Input
            mono
            disabled={disabled}
            value={condition.attribute}
            onChange={(e) => onChange({ attribute: e.target.value })}
            placeholder="user_level"
            className="h-7 flex-1 min-w-[120px] max-w-[180px] text-[12px]"
          />
          <OpSelect
            disabled={disabled}
            ariaLabel={t(meta.labelKey)}
            value={condition.scalarOp}
            onChange={(v) => onChange({ scalarOp: v as CompareOp })}
            options={COMPARE_OPS}
          />
          <Input
            mono
            disabled={disabled}
            value={condition.scalarValue}
            onChange={(e) => onChange({ scalarValue: e.target.value })}
            placeholder="42"
            className="h-7 flex-1 min-w-[120px] text-[12px]"
          />
        </>
      )}

      {(condition.kind === "country" ||
        condition.kind === "app" ||
        condition.kind === "platform") && (
        <>
          <OpSelect
            disabled={disabled}
            ariaLabel={t(meta.labelKey)}
            value={condition.listOp}
            onChange={(v) => onChange({ listOp: v as ListOp })}
            options={LIST_OPS}
          />
          {condition.kind === "platform" ? (
            <PlatformChips
              disabled={disabled}
              values={condition.listValues}
              onChange={(next) => onChange({ listValues: next })}
            />
          ) : (
            <ChipInput
              disabled={disabled}
              values={condition.listValues}
              onChange={(next) => onChange({ listValues: next })}
              placeholder={
                condition.kind === "country"
                  ? "TR, DE, US"
                  : "com.example.app"
              }
            />
          )}
        </>
      )}

      {(condition.kind === "appVersion" ||
        condition.kind === "sdkVersion") && (
        <>
          <OpSelect
            disabled={disabled}
            ariaLabel={t(meta.labelKey)}
            value={condition.scalarOp}
            onChange={(v) => onChange({ scalarOp: v as CompareOp })}
            options={COMPARE_OPS}
          />
          <Input
            mono
            disabled={disabled}
            value={condition.scalarValue}
            onChange={(e) => onChange({ scalarValue: e.target.value })}
            placeholder="1.2.3"
            className="h-7 flex-1 min-w-[120px] text-[12px]"
          />
        </>
      )}

      <button
        type="button"
        aria-label={t("targeting.conditions.removeCondition")}
        onClick={onRemove}
        disabled={disabled}
        aria-disabled={disabled}
        className="ml-auto inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function ChipInput({
  values,
  onChange,
  placeholder,
  disabled,
}: {
  values: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    const parts = trimmed
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !values.includes(p));
    if (parts.length === 0) {
      setDraft("");
      return;
    }
    onChange([...values, ...parts]);
    setDraft("");
  };

  return (
    <div className="flex flex-1 flex-wrap items-center gap-1 rounded border border-rv-divider bg-rv-c2 px-1.5 py-1 min-w-[160px]">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded bg-rv-c4 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-700"
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            disabled={disabled}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="text-rv-mute-500 hover:text-rv-danger disabled:cursor-not-allowed disabled:opacity-50"
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (
            e.key === "Backspace" &&
            draft === "" &&
            values.length > 0
          ) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={values.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[80px] bg-transparent font-rv-mono text-[11px] text-foreground placeholder:text-rv-mute-500 outline-none disabled:cursor-not-allowed"
      />
    </div>
  );
}

function PlatformChips({
  values,
  onChange,
  disabled,
}: {
  values: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const selected = new Set(values);
  return (
    <div className="flex flex-1 flex-wrap items-center gap-1">
      {PLATFORM_VALUES.map((p) => {
        const isOn = selected.has(p.value);
        return (
          <button
            key={p.value}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              if (isOn) onChange(values.filter((v) => v !== p.value));
              else onChange([...values, p.value]);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-rv-mono text-[10px] transition",
              isOn
                ? "border-rv-accent-500 bg-rv-accent-500/10 text-rv-accent-500"
                : "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:border-rv-accent-500/40",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {isOn && <Check size={9} />}
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
