import {
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  FileText,
  Flag as FlagIcon,
  Globe2,
  KeyRound,
  Layers,
  Package,
  Plus,
  Power,
  Smartphone,
  Tag,
  Target,
  Trash2,
  Type as TypeIcon,
  Wand2,
} from "lucide-react";
import type {
  DashboardFlagEnv,
  DashboardFlagRule,
  DashboardFlagType,
  FeatureFlagListItem,
} from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Segmented } from "../../ui/segmented";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import { ApiError } from "../../lib/api";
import {
  useCreateFeatureFlag,
  useUpdateFeatureFlag,
} from "../../lib/hooks/useFeatureFlags";
import type { FlagEnv } from "./types";
import {
  conditionsToSift,
  makeCondition,
  siftToConditions,
  type CompareOp,
  type ConditionKind,
  type DraftCondition,
  type ListOp,
} from "../targeting/sift-codec";

const UI_TO_DB_ENV: Record<FlagEnv, DashboardFlagEnv> = {
  prod: "PROD",
  staging: "STAGING",
  development: "DEVELOPMENT",
};

const DB_TO_UI_ENV: Record<DashboardFlagEnv, FlagEnv> = {
  PROD: "prod",
  STAGING: "staging",
  DEVELOPMENT: "development",
};

// =============================================================
// Type catalogue + condition catalogue
// =============================================================

const TYPE_OPTIONS: ReadonlyArray<{
  value: DashboardFlagType;
  labelKey: string;
}> = [
  { value: "BOOLEAN", labelKey: "featureFlags.new.types.boolean" },
  { value: "STRING", labelKey: "featureFlags.new.types.string" },
  { value: "NUMBER", labelKey: "featureFlags.new.types.number" },
  { value: "JSON", labelKey: "featureFlags.new.types.json" },
];

const ENV_OPTIONS: ReadonlyArray<FlagEnv> = ["prod", "staging", "development"];

const CONDITION_TYPES: ReadonlyArray<{
  kind: ConditionKind;
  labelKey: string;
  icon: ReactNode;
}> = [
  { kind: "customAttribute", labelKey: "featureFlags.new.conditions.types.customAttribute", icon: <KeyRound size={11} /> },
  { kind: "country", labelKey: "featureFlags.new.conditions.types.country", icon: <Globe2 size={11} /> },
  { kind: "app", labelKey: "featureFlags.new.conditions.types.app", icon: <Package size={11} /> },
  { kind: "appVersion", labelKey: "featureFlags.new.conditions.types.appVersion", icon: <Tag size={11} /> },
  { kind: "platform", labelKey: "featureFlags.new.conditions.types.platform", icon: <Smartphone size={11} /> },
  { kind: "sdkVersion", labelKey: "featureFlags.new.conditions.types.sdkVersion", icon: <Layers size={11} /> },
];

const LIST_OPS: ReadonlyArray<{ value: ListOp; labelKey: string }> = [
  { value: "$in", labelKey: "featureFlags.new.conditions.ops.in" },
  { value: "$nin", labelKey: "featureFlags.new.conditions.ops.notIn" },
];

const COMPARE_OPS: ReadonlyArray<{ value: CompareOp; labelKey: string }> = [
  { value: "$eq", labelKey: "featureFlags.new.conditions.ops.eq" },
  { value: "$ne", labelKey: "featureFlags.new.conditions.ops.ne" },
  { value: "$gte", labelKey: "featureFlags.new.conditions.ops.gte" },
  { value: "$gt", labelKey: "featureFlags.new.conditions.ops.gt" },
  { value: "$lte", labelKey: "featureFlags.new.conditions.ops.lte" },
  { value: "$lt", labelKey: "featureFlags.new.conditions.ops.lt" },
];

const PLATFORM_VALUES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "ios", label: "iOS" },
  { value: "android", label: "Android" },
  { value: "web", label: "Web" },
];

interface DraftRule {
  audienceId?: string; // preserved when editing legacy rules; never set on new
  conditions: DraftCondition[];
  strValue: string;
  numValue: number;
  boolValue: boolean;
  jsonValue: string;
  rolloutPct: number; // 0-100
}

function makeRule(): DraftRule {
  return {
    conditions: [],
    strValue: "",
    numValue: 0,
    boolValue: true,
    jsonValue: "{}",
    rolloutPct: 100,
  };
}

// =============================================================
// JSON helpers
// =============================================================

type JsonState =
  | { ok: true; value: unknown; pretty: string }
  | { ok: false; error: string };

function validateJson(raw: string): JsonState {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "value cannot be empty" };
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    return { ok: true, value, pretty: JSON.stringify(value, null, 2) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "invalid JSON",
    };
  }
}

// =============================================================
// Seed helpers (edit mode)
// =============================================================

function seedRule(stored: DashboardFlagRule, type: DashboardFlagType): DraftRule {
  const base = makeRule();
  const pct =
    typeof stored.rolloutPercentage === "number"
      ? Math.round(stored.rolloutPercentage * 100)
      : 100;
  const draft: DraftRule = {
    ...base,
    audienceId: stored.audienceId,
    conditions: siftToConditions(stored.conditions),
    rolloutPct: pct,
  };
  if (type === "BOOLEAN") draft.boolValue = Boolean(stored.value);
  else if (type === "NUMBER")
    draft.numValue = Number(stored.value) || 0;
  else if (type === "STRING") draft.strValue = String(stored.value ?? "");
  else
    draft.jsonValue =
      stored.value === undefined ? "{}" : JSON.stringify(stored.value, null, 2);
  return draft;
}

// =============================================================
// Page
// =============================================================

export interface FlagFormProps {
  projectId: string;
  initialFlag?: FeatureFlagListItem;
}

export function FlagForm({ projectId, initialFlag }: FlagFormProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isEdit = Boolean(initialFlag);
  const create = useCreateFeatureFlag();
  const update = useUpdateFeatureFlag();

  const [key, setKey] = useState(initialFlag?.key ?? "");
  const [description, setDescription] = useState(initialFlag?.description ?? "");
  const [type, setType] = useState<DashboardFlagType>(
    initialFlag?.type ?? "BOOLEAN",
  );
  const [isEnabled, setIsEnabled] = useState(initialFlag?.isEnabled ?? true);
  const [env, setEnv] = useState<FlagEnv>(
    initialFlag ? DB_TO_UI_ENV[initialFlag.env] : "prod",
  );

  // Default value (per-type cells kept in parallel)
  const seededDefault = initialFlag?.defaultValue;
  const [boolDefault, setBoolDefault] = useState(
    initialFlag?.type === "BOOLEAN" ? Boolean(seededDefault) : false,
  );
  const [strDefault, setStrDefault] = useState(
    initialFlag?.type === "STRING" ? String(seededDefault ?? "") : "",
  );
  const [numDefault, setNumDefault] = useState<number>(
    initialFlag?.type === "NUMBER" ? Number(seededDefault) || 0 : 0,
  );
  const [jsonDefault, setJsonDefault] = useState(
    initialFlag?.type === "JSON"
      ? JSON.stringify(seededDefault, null, 2)
      : "{}",
  );

  const [rules, setRules] = useState<DraftRule[]>(() => {
    if (initialFlag) {
      return initialFlag.rules.map((r) => seedRule(r, initialFlag.type));
    }
    return [];
  });
  const [formError, setFormError] = useState<string | null>(null);

  const jsonState = useMemo(() => validateJson(jsonDefault), [jsonDefault]);
  const ruleJsonStates = useMemo<ReadonlyArray<JsonState | null>>(
    () =>
      rules.map((r) => (type === "JSON" ? validateJson(r.jsonValue) : null)),
    [rules, type],
  );

  const defaultValid = type !== "JSON" || jsonState.ok;
  const rulesValid =
    type !== "JSON" || ruleJsonStates.every((s) => s === null || s.ok);

  const updateRule = (idx: number, patch: Partial<DraftRule>) =>
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const updateCondition = (
    ruleIdx: number,
    condIdx: number,
    patch: Partial<DraftCondition>,
  ) =>
    setRules((prev) =>
      prev.map((r, i) =>
        i === ruleIdx
          ? {
              ...r,
              conditions: r.conditions.map((c, ci) =>
                ci === condIdx ? { ...c, ...patch } : c,
              ),
            }
          : r,
      ),
    );
  const addCondition = (ruleIdx: number, kind: ConditionKind) =>
    setRules((prev) =>
      prev.map((r, i) =>
        i === ruleIdx
          ? { ...r, conditions: [...r.conditions, makeCondition(kind)] }
          : r,
      ),
    );
  const removeCondition = (ruleIdx: number, condIdx: number) =>
    setRules((prev) =>
      prev.map((r, i) =>
        i === ruleIdx
          ? {
              ...r,
              conditions: r.conditions.filter((_, ci) => ci !== condIdx),
            }
          : r,
      ),
    );
  const addRule = () => setRules((prev) => [...prev, makeRule()]);
  const removeRule = (idx: number) =>
    setRules((prev) => prev.filter((_, i) => i !== idx));

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);

    if (!key.trim()) {
      setFormError(t("featureFlags.new.errors.required"));
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(key.trim())) {
      setFormError(t("featureFlags.new.errors.invalidKey"));
      return;
    }

    let defaultValue: unknown;
    if (type === "BOOLEAN") defaultValue = boolDefault;
    else if (type === "STRING") defaultValue = strDefault;
    else if (type === "NUMBER")
      defaultValue = Number.isFinite(numDefault) ? numDefault : 0;
    else {
      if (!jsonState.ok) {
        setFormError(
          t("featureFlags.new.errors.invalidJsonDefault", {
            error: jsonState.error,
          }),
        );
        return;
      }
      defaultValue = jsonState.value;
    }

    let parsedRules: DashboardFlagRule[];
    try {
      parsedRules = rules.map((r, idx) => {
        let value: unknown;
        if (type === "BOOLEAN") value = r.boolValue;
        else if (type === "STRING") value = r.strValue;
        else if (type === "NUMBER")
          value = Number.isFinite(r.numValue) ? r.numValue : 0;
        else {
          const parsed = validateJson(r.jsonValue);
          if (!parsed.ok) {
            throw new Error(
              t("featureFlags.new.errors.invalidJsonRule", {
                index: idx + 1,
                error: parsed.error,
              }),
            );
          }
          value = parsed.value;
        }
        const conditions = conditionsToSift(r.conditions);
        const pct = Math.max(0, Math.min(100, Math.round(r.rolloutPct)));
        const rule: DashboardFlagRule = {
          value,
          rolloutPercentage: pct / 100,
        };
        if (r.audienceId) rule.audienceId = r.audienceId;
        if (conditions) rule.conditions = conditions;
        return rule;
      });
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : t("featureFlags.new.errors.unknown"),
      );
      return;
    }

    const dbEnv = UI_TO_DB_ENV[env];
    try {
      if (initialFlag) {
        await update.mutateAsync({
          id: initialFlag.id,
          body: {
            env: dbEnv,
            defaultValue,
            rules: parsedRules,
            isEnabled,
            description: description.trim() ? description.trim() : null,
          },
        });
      } else {
        await create.mutateAsync({
          projectId,
          key: key.trim(),
          type,
          env: dbEnv,
          defaultValue,
          rules: parsedRules,
          isEnabled,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
      }
      void navigate({
        to: "/projects/$projectId/feature-flags",
        params: { projectId },
      });
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : t("featureFlags.new.errors.unknown"),
      );
    }
  };

  const pending = create.isPending || update.isPending;
  const submitDisabled = pending || !defaultValid || !rulesValid;

  return (
    <>
      <header className="flex items-start justify-between gap-4 pb-5">
        <div className="min-w-0">
          <Link
            to="/projects/$projectId/feature-flags"
            params={{ projectId }}
            className="inline-flex items-center gap-1 text-[12px] text-rv-mute-500 hover:text-foreground"
          >
            <ArrowLeft size={12} />
            {t("featureFlags.new.back")}
          </Link>
          <h1 className="mt-2 text-[24px] font-semibold leading-8 tracking-tight">
            {isEdit
              ? t("featureFlags.edit.title")
              : t("featureFlags.new.title")}
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
            {isEdit
              ? t("featureFlags.edit.subtitle")
              : t("featureFlags.new.subtitle")}
          </p>
        </div>
      </header>

      <form
        onSubmit={handleSubmit}
        className="grid max-w-3xl grid-cols-1 gap-5"
      >
        <Section
          icon={<FileText size={13} />}
          title={t("featureFlags.new.sections.basics")}
          subtitle={t("featureFlags.new.sections.basicsSub")}
        >
          <Field
            icon={<KeyRound size={11} />}
            label={t("featureFlags.new.fields.key")}
            description={t("featureFlags.new.descriptions.key")}
          >
            <Input
              value={key}
              mono
              onChange={(e) => setKey(e.target.value)}
              placeholder="new_onboarding_flow"
              required
              disabled={isEdit}
            />
            {isEdit && (
              <span className="mt-1 text-[10px] text-rv-mute-500">
                {t("featureFlags.edit.keyLocked")}
              </span>
            )}
          </Field>
          <Field
            icon={<Tag size={11} />}
            label={t("featureFlags.new.fields.description")}
            description={t("featureFlags.new.descriptions.description")}
            optional
          >
            <Textarea
              value={description ?? ""}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t("featureFlags.new.placeholders.description")}
            />
          </Field>
          <Field
            icon={<Globe2 size={11} />}
            label={t("featureFlags.new.fields.env")}
            description={t("featureFlags.new.descriptions.env")}
          >
            <Segmented
              options={ENV_OPTIONS}
              value={env}
              onChange={setEnv}
              ariaLabel={t("featureFlags.new.fields.env")}
            />
          </Field>
          <Field
            icon={<Power size={11} />}
            label={t("featureFlags.new.fields.enabled")}
            description={t("featureFlags.new.descriptions.enabled")}
          >
            <div className="inline-flex items-center gap-3 rounded-md border border-rv-divider bg-rv-c1 px-3 py-2">
              <Switch
                checked={isEnabled}
                onChange={setIsEnabled}
                ariaLabel={t("featureFlags.new.fields.enabled")}
              />
              <span className="font-rv-mono text-[12px] tabular-nums text-rv-mute-700">
                {isEnabled
                  ? t("featureFlags.new.enabledOn")
                  : t("featureFlags.new.enabledOff")}
              </span>
            </div>
          </Field>
        </Section>

        <Section
          icon={<Layers size={13} />}
          title={t("featureFlags.new.sections.type")}
          subtitle={t("featureFlags.new.sections.typeSub")}
        >
          <Field
            icon={<TypeIcon size={11} />}
            label={t("featureFlags.new.fields.type")}
            description={t(
              `featureFlags.new.typeDescriptions.${type.toLowerCase()}`,
            )}
          >
            <Select
              value={type}
              onChange={(e) => setType(e.target.value as DashboardFlagType)}
              disabled={isEdit}
            >
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </option>
              ))}
            </Select>
            {isEdit && (
              <span className="mt-1 text-[10px] text-rv-mute-500">
                {t("featureFlags.edit.typeLocked")}
              </span>
            )}
          </Field>

          <Field
            icon={<FlagIcon size={11} />}
            label={t("featureFlags.new.fields.defaultValue")}
            description={t("featureFlags.new.descriptions.defaultValue")}
          >
            <DefaultValueEditor
              type={type}
              boolValue={boolDefault}
              strValue={strDefault}
              numValue={numDefault}
              jsonValue={jsonDefault}
              jsonState={jsonState}
              onBoolChange={setBoolDefault}
              onStrChange={setStrDefault}
              onNumChange={setNumDefault}
              onJsonChange={setJsonDefault}
            />
          </Field>
        </Section>

        <Section
          icon={<Target size={13} />}
          title={t("featureFlags.new.sections.rules")}
          subtitle={t("featureFlags.new.sections.rulesSub")}
          right={
            <span className="inline-flex items-center gap-1 rounded-full border border-rv-divider bg-rv-c4 px-2 py-0.5 font-rv-mono text-[10px] text-rv-mute-700">
              {t("featureFlags.new.rules.count", { count: rules.length })}
            </span>
          }
        >
          <div className="flex flex-col gap-3">
            {rules.map((r, ruleIdx) => {
              const jsonErr =
                type === "JSON" && ruleJsonStates[ruleIdx]?.ok === false
                  ? ruleJsonStates[ruleIdx]!.error
                  : null;
              return (
                <div
                  key={ruleIdx}
                  className="rounded-md border border-rv-divider bg-rv-c2 p-3.5"
                >
                  <div className="mb-3 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-rv-accent-500/10 px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-accent-500">
                      <Target size={9} />
                      {t("featureFlags.new.rules.ordinal", { index: ruleIdx + 1 })}
                    </span>
                    {r.audienceId && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-rv-divider bg-rv-c4 px-2 py-0.5 font-rv-mono text-[10px] text-rv-mute-700">
                        {t("featureFlags.new.rules.legacyAudience")}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={t("featureFlags.new.rules.remove")}
                      onClick={() => removeRule(ruleIdx)}
                      className="ml-auto inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>

                  <Field
                    label={t("featureFlags.new.fields.conditions")}
                    description={t("featureFlags.new.descriptions.conditions")}
                    dense
                  >
                    <div className="flex flex-col gap-2">
                      {r.conditions.length === 0 && (
                        <span className="text-[11px] italic text-rv-mute-500">
                          {t("featureFlags.new.conditions.empty")}
                        </span>
                      )}
                      {r.conditions.map((c, condIdx) => (
                        <ConditionRow
                          key={condIdx}
                          condition={c}
                          onChange={(patch) =>
                            updateCondition(ruleIdx, condIdx, patch)
                          }
                          onRemove={() => removeCondition(ruleIdx, condIdx)}
                        />
                      ))}
                      <ConditionMenu
                        onPick={(kind) => addCondition(ruleIdx, kind)}
                      />
                    </div>
                  </Field>

                  <Field
                    label={t("featureFlags.new.fields.rollout")}
                    description={t("featureFlags.new.descriptions.rollout")}
                    dense
                    className="mt-3"
                  >
                    <RolloutSlider
                      value={r.rolloutPct}
                      onChange={(next) =>
                        updateRule(ruleIdx, { rolloutPct: next })
                      }
                    />
                  </Field>

                  <div className="mt-3">
                    <Field
                      label={t("featureFlags.new.fields.ruleValue")}
                      description={t("featureFlags.new.descriptions.ruleValue")}
                      dense
                    >
                      <DefaultValueEditor
                        type={type}
                        boolValue={r.boolValue}
                        strValue={r.strValue}
                        numValue={r.numValue}
                        jsonValue={r.jsonValue}
                        jsonState={
                          type === "JSON"
                            ? ruleJsonStates[ruleIdx] ??
                              validateJson(r.jsonValue)
                            : null
                        }
                        onBoolChange={(next) =>
                          updateRule(ruleIdx, { boolValue: next })
                        }
                        onStrChange={(next) =>
                          updateRule(ruleIdx, { strValue: next })
                        }
                        onNumChange={(next) =>
                          updateRule(ruleIdx, { numValue: next })
                        }
                        onJsonChange={(next) =>
                          updateRule(ruleIdx, { jsonValue: next })
                        }
                      />
                    </Field>
                    {jsonErr && (
                      <span className="mt-1 inline-flex items-start gap-1 font-rv-mono text-[10px] text-rv-danger">
                        <AlertCircle size={10} className="mt-px flex-shrink-0" />
                        {jsonErr}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={addRule}
            className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-rv-divider-strong bg-transparent px-4 py-3 text-[12px] font-medium text-rv-mute-600 transition hover:border-rv-accent-500 hover:bg-rv-accent-500/5 hover:text-rv-accent-500"
          >
            <Plus size={13} />
            {t("featureFlags.new.rules.add")}
          </button>
        </Section>

        {formError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {formError}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2">
          <Button
            type="submit"
            variant="solid-primary"
            disabled={submitDisabled}
          >
            {isEdit
              ? pending
                ? t("featureFlags.edit.submitting")
                : t("featureFlags.edit.submit")
              : pending
                ? t("featureFlags.new.submitting")
                : t("featureFlags.new.submit")}
          </Button>
          <Link
            to="/projects/$projectId/feature-flags"
            params={{ projectId }}
            className="text-[12px] text-rv-mute-500 hover:text-foreground"
          >
            {t("featureFlags.new.cancel")}
          </Link>
        </div>
      </form>
    </>
  );
}

// =============================================================
// Condition row + add menu
// =============================================================

function ConditionMenu({
  onPick,
}: {
  onPick: (kind: ConditionKind) => void;
}) {
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
        {t("featureFlags.new.conditions.add")}
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

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: DraftCondition;
  onChange: (patch: Partial<DraftCondition>) => void;
  onRemove: () => void;
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
            value={condition.attribute}
            onChange={(e) => onChange({ attribute: e.target.value })}
            placeholder="user_level"
            className="h-7 flex-1 min-w-[120px] max-w-[180px] text-[12px]"
          />
          <Select
            value={condition.scalarOp}
            onChange={(e) =>
              onChange({ scalarOp: e.target.value as CompareOp })
            }
            className="h-7 w-[80px] text-[12px]"
          >
            {COMPARE_OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {t(op.labelKey)}
              </option>
            ))}
          </Select>
          <Input
            mono
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
          <Select
            value={condition.listOp}
            onChange={(e) => onChange({ listOp: e.target.value as ListOp })}
            className="h-7 w-[80px] text-[12px]"
          >
            {LIST_OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {t(op.labelKey)}
              </option>
            ))}
          </Select>
          {condition.kind === "platform" ? (
            <PlatformChips
              values={condition.listValues}
              onChange={(next) => onChange({ listValues: next })}
            />
          ) : (
            <ChipInput
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
          <Select
            value={condition.scalarOp}
            onChange={(e) =>
              onChange({ scalarOp: e.target.value as CompareOp })
            }
            className="h-7 w-[80px] text-[12px]"
          >
            {COMPARE_OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {t(op.labelKey)}
              </option>
            ))}
          </Select>
          <Input
            mono
            value={condition.scalarValue}
            onChange={(e) => onChange({ scalarValue: e.target.value })}
            placeholder="1.2.3"
            className="h-7 flex-1 min-w-[120px] text-[12px]"
          />
        </>
      )}

      <button
        type="button"
        aria-label={t("featureFlags.new.conditions.removeCondition")}
        onClick={onRemove}
        className="ml-auto inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
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
}: {
  values: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  placeholder: string;
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
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="text-rv-mute-500 hover:text-rv-danger"
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={values.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[80px] bg-transparent font-rv-mono text-[11px] text-foreground placeholder:text-rv-mute-500 outline-none"
      />
    </div>
  );
}

function PlatformChips({
  values,
  onChange,
}: {
  values: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
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
            onClick={() => {
              if (isOn) onChange(values.filter((v) => v !== p.value));
              else onChange([...values, p.value]);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-rv-mono text-[10px] transition",
              isOn
                ? "border-rv-accent-500 bg-rv-accent-500/10 text-rv-accent-500"
                : "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:border-rv-accent-500/40",
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

// =============================================================
// Default/rule value editor (one per flag type)
// =============================================================

function DefaultValueEditor({
  type,
  boolValue,
  strValue,
  numValue,
  jsonValue,
  jsonState,
  onBoolChange,
  onStrChange,
  onNumChange,
  onJsonChange,
}: {
  type: DashboardFlagType;
  boolValue: boolean;
  strValue: string;
  numValue: number;
  jsonValue: string;
  jsonState: JsonState | null;
  onBoolChange: (next: boolean) => void;
  onStrChange: (next: string) => void;
  onNumChange: (next: number) => void;
  onJsonChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  if (type === "BOOLEAN") {
    return (
      <div className="inline-flex items-center gap-3 rounded-md border border-rv-divider bg-rv-c1 px-3 py-2">
        <Switch
          checked={boolValue}
          onChange={onBoolChange}
          ariaLabel={t("featureFlags.new.fields.defaultValue")}
        />
        <span className="font-rv-mono text-[12px] tabular-nums">
          {boolValue ? "true" : "false"}
        </span>
      </div>
    );
  }
  if (type === "STRING") {
    return (
      <Input
        mono
        value={strValue}
        onChange={(e) => onStrChange(e.target.value)}
        placeholder='"enabled"'
      />
    );
  }
  if (type === "NUMBER") {
    return (
      <Input
        mono
        type="number"
        step="any"
        value={numValue}
        onChange={(e) => onNumChange(Number(e.target.value))}
      />
    );
  }
  const valid = jsonState?.ok ?? true;
  const handleFormat = () => {
    if (jsonState?.ok) onJsonChange(jsonState.pretty);
  };
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-rv-c1",
        valid
          ? "border-rv-divider"
          : "border-rv-danger/40 ring-1 ring-rv-danger/20",
      )}
    >
      <div className="flex items-center justify-between border-b border-rv-divider bg-rv-c2/40 px-2.5 py-1.5">
        <div
          className={cn(
            "inline-flex items-center gap-1 font-rv-mono text-[10px]",
            valid ? "text-rv-success" : "text-rv-danger",
          )}
        >
          {valid ? <Check size={10} /> : <AlertCircle size={10} />}
          {valid
            ? t("featureFlags.new.json.valid")
            : t("featureFlags.new.json.invalid")}
        </div>
        <button
          type="button"
          onClick={handleFormat}
          disabled={!valid}
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded px-2 font-rv-mono text-[10px] text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-rv-mute-600"
        >
          <Wand2 size={10} />
          {t("featureFlags.new.json.format")}
        </button>
      </div>
      <Textarea
        aria-label={t("featureFlags.new.fields.defaultValue")}
        className="rounded-none border-0 bg-transparent font-rv-mono text-[12px] focus:ring-0"
        rows={4}
        value={jsonValue}
        onChange={(e) => onJsonChange(e.target.value)}
        placeholder='{ "variant": "a" }'
      />
    </div>
  );
}

// =============================================================
// Layout helpers
// =============================================================

function Section({
  icon,
  title,
  subtitle,
  right,
  children,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="flex items-start justify-between gap-3 border-b border-rv-divider bg-rv-c2/40 px-4 py-3">
        <div className="flex items-start gap-2.5">
          {icon && (
            <span className="mt-0.5 inline-flex size-6 items-center justify-center rounded-md bg-rv-accent-500/10 text-rv-accent-500">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[13px] font-medium leading-5">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-[11px] leading-snug text-rv-mute-500">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {right}
      </div>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </section>
  );
}

function Field({
  icon,
  label,
  description,
  optional,
  dense,
  className,
  children,
}: {
  icon?: ReactNode;
  label: string;
  description?: string;
  optional?: boolean;
  dense?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cn("flex flex-col", dense ? "gap-1" : "gap-1.5", className)}
    >
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {icon && <span className="text-rv-mute-400">{icon}</span>}
        {label}
        {optional && (
          <span className="ml-0.5 text-rv-mute-400 normal-case tracking-normal">
            (optional)
          </span>
        )}
      </span>
      {description && (
        <span className="text-[11px] leading-snug text-rv-mute-500">
          {description}
        </span>
      )}
      {children}
    </label>
  );
}

function RolloutSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-rv-c3 accent-rv-accent-500"
        style={{
          background: `linear-gradient(to right, var(--color-rv-accent-500) 0%, var(--color-rv-accent-500) ${pct}%, var(--color-rv-c3) ${pct}%, var(--color-rv-c3) 100%)`,
        }}
      />
      <div className="flex w-20 items-center gap-1.5 rounded border border-rv-divider bg-rv-c1 px-2 py-1 font-rv-mono text-[11px] tabular-nums">
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full appearance-none border-0 bg-transparent p-0 text-[11px] focus:outline-none focus:ring-0"
        />
        <span className="text-rv-mute-500">%</span>
      </div>
    </div>
  );
}
