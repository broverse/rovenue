import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { VirtualCurrency } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { Switch } from "../../ui/switch";
import { cn } from "../../lib/cn";
import type {
  ConfiguredLeaderboard,
  LeaderboardCadence,
  LeaderboardMetric,
} from "../../lib/hooks/useProjectAdmin";

// =============================================================
// Cadence / metric label lookups
// =============================================================
//
// Explicit maps, never a runtime-built key (`leaderboards.cadence.${x}`) --
// a runtime-assembled key is invisible to the i18n extractor and ships as
// a missing translation. See task-7-brief.md.

export const CADENCE_LABEL_KEYS: Record<LeaderboardCadence, string> = {
  WEEKLY: "leaderboards.cadence.weekly",
  MONTHLY: "leaderboards.cadence.monthly",
  CUSTOM: "leaderboards.cadence.custom",
};

export const METRIC_LABEL_KEYS: Record<LeaderboardMetric, string> = {
  TOP_SPENDERS: "leaderboards.metric.topSpenders",
  TOP_CONSUMERS: "leaderboards.metric.topConsumers",
};

const CADENCE_OPTIONS: ReadonlyArray<LeaderboardCadence> = [
  "WEEKLY",
  "MONTHLY",
  "CUSTOM",
];
const METRIC_OPTIONS: ReadonlyArray<LeaderboardMetric> = [
  "TOP_SPENDERS",
  "TOP_CONSUMERS",
];

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_ENTRY_LIMIT = 100;
const MIN_ENTRY_LIMIT = 1;
const MIN_CUSTOM_PERIOD_DAYS = 1;

function isPositiveInteger(raw: string): boolean {
  if (raw.trim() === "") return false;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_CUSTOM_PERIOD_DAYS;
}

export interface LeaderboardCreateInput {
  identifier: string;
  name: string;
  metric: LeaderboardMetric;
  currencyId: string | null;
  cadence: LeaderboardCadence;
  customPeriodDays: number | null;
  timezone: string;
  entryLimit: number;
  isEnabled: boolean;
}

export interface LeaderboardUpdateInput {
  name: string;
  currencyId: string | null;
  entryLimit: number;
  timezone: string;
  isEnabled: boolean;
}

interface Props {
  open: boolean;
  mode: "create" | "edit";
  initial?: ConfiguredLeaderboard;
  currencies: VirtualCurrency[];
  onClose: () => void;
  onSave: (
    input: LeaderboardCreateInput | LeaderboardUpdateInput,
  ) => void | Promise<void>;
}

/**
 * Create/edit dialog for a configured, season-based leaderboard. Only
 * `name`, `currencyId`, `entryLimit`, `timezone` and `isEnabled` are
 * editable after creation (mirrors the server's `updateLeaderboardBodySchema`
 * in apps/api/src/routes/dashboard/leaderboards.ts) -- identifier, metric,
 * cadence and customPeriodDays are locked once the row exists.
 */
export function LeaderboardFormDialog(props: Props) {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[480px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {props.open && <DialogBody {...props} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DialogBody(props: Props) {
  const { t } = useTranslation();
  const identifierId = useId();
  const nameId = useId();
  const metricId = useId();
  const currencyId2 = useId();
  const cadenceId = useId();
  const customPeriodDaysId = useId();
  const timezoneId = useId();
  const entryLimitId = useId();
  const identifierRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const editing = props.mode === "edit";
  const initial = props.initial;

  const [identifier, setIdentifier] = useState(initial?.identifier ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [metric, setMetric] = useState<LeaderboardMetric>(
    initial?.metric ?? "TOP_SPENDERS",
  );
  const [currencyId, setCurrencyId] = useState<string>(
    initial?.currencyId ?? "",
  );
  const [cadence, setCadence] = useState<LeaderboardCadence>(
    initial?.cadence ?? "WEEKLY",
  );
  const [customPeriodDays, setCustomPeriodDays] = useState(
    initial?.customPeriodDays != null ? String(initial.customPeriodDays) : "",
  );
  const [timezone, setTimezone] = useState(initial?.timezone ?? DEFAULT_TIMEZONE);
  const [entryLimit, setEntryLimit] = useState(
    String(initial?.entryLimit ?? DEFAULT_ENTRY_LIMIT),
  );
  const [isEnabled, setIsEnabled] = useState(initial?.isEnabled ?? true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) identifierRef.current?.focus();
    else nameRef.current?.focus();
  }, [editing]);

  const isCustomCadence = cadence === "CUSTOM";
  const customPeriodDaysInvalid =
    !editing && isCustomCadence && !isPositiveInteger(customPeriodDays);

  const submitDisabled =
    pending ||
    (!editing && (!identifier.trim() || !name.trim() || customPeriodDaysInvalid)) ||
    (editing && !name.trim());

  async function submit() {
    setError(null);
    if (!editing) {
      if (!identifier.trim()) {
        setError(t("leaderboards.form.errors.identifierRequired"));
        return;
      }
      if (!name.trim()) {
        setError(t("leaderboards.form.errors.nameRequired"));
        return;
      }
      if (isCustomCadence && !isPositiveInteger(customPeriodDays)) {
        setError(t("leaderboards.form.errors.customPeriodDaysRequired"));
        return;
      }
      setPending(true);
      try {
        await props.onSave({
          identifier: identifier.trim(),
          name: name.trim(),
          metric,
          currencyId: metric === "TOP_CONSUMERS" && currencyId ? currencyId : null,
          cadence,
          customPeriodDays: isCustomCadence ? Number(customPeriodDays) : null,
          timezone: timezone.trim() || DEFAULT_TIMEZONE,
          entryLimit: Math.max(MIN_ENTRY_LIMIT, Number(entryLimit) || DEFAULT_ENTRY_LIMIT),
          isEnabled,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : t("leaderboards.form.errors.unknown"));
      } finally {
        setPending(false);
      }
      return;
    }

    if (!name.trim()) {
      setError(t("leaderboards.form.errors.nameRequired"));
      return;
    }
    setPending(true);
    try {
      await props.onSave({
        name: name.trim(),
        currencyId: metric === "TOP_CONSUMERS" && currencyId ? currencyId : null,
        entryLimit: Math.max(MIN_ENTRY_LIMIT, Number(entryLimit) || DEFAULT_ENTRY_LIMIT),
        timezone: timezone.trim() || DEFAULT_TIMEZONE,
        isEnabled,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("leaderboards.form.errors.unknown"));
    } finally {
      setPending(false);
    }
  }

  const title = editing
    ? t("leaderboards.form.editTitle")
    : t("leaderboards.form.createTitle");
  const subtitle = editing
    ? t("leaderboards.form.editSubtitle")
    : t("leaderboards.form.createSubtitle");
  const submitLabel = editing
    ? pending
      ? t("common.saving")
      : t("common.saveChanges")
    : pending
      ? t("common.saving")
      : t("leaderboards.form.submit.create");

  return (
    <div className="flex flex-col">
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <div>
          <Dialog.Title className="text-[15px] font-semibold leading-5">
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-0.5 max-w-[380px] text-[12px] text-rv-mute-500">
            {subtitle}
          </Dialog.Description>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label={t("common.close")}
          className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-5 py-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={identifierId} className="text-[12px] font-medium text-foreground">
            {t("leaderboards.form.fields.identifier")}
          </label>
          <Input
            id={identifierId}
            ref={identifierRef}
            mono
            value={identifier}
            onChange={(e) => { if (!editing) setIdentifier(e.target.value); }}
            placeholder="weekly-top-spenders"
            autoComplete="off"
            spellCheck={false}
            disabled={editing}
          />
          <p className="text-[11px] leading-snug text-rv-mute-500">
            {editing
              ? t("leaderboards.form.identifier.locked")
              : t("leaderboards.form.identifier.hint")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-[12px] font-medium text-foreground">
            {t("leaderboards.form.fields.name")}
          </label>
          <Input
            id={nameId}
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Weekly top spenders"
            autoComplete="off"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={metricId} className="text-[12px] font-medium text-foreground">
              {t("leaderboards.form.fields.metric")}
            </label>
            <NativeSelect
              id={metricId}
              value={metric}
              onChange={(e) => setMetric(e.target.value as LeaderboardMetric)}
              disabled={editing}
            >
              {METRIC_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {t(METRIC_LABEL_KEYS[m])}
                </option>
              ))}
            </NativeSelect>
            {editing && (
              <p className="text-[11px] leading-snug text-rv-mute-500">
                {t("leaderboards.form.metric.locked")}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={cadenceId} className="text-[12px] font-medium text-foreground">
              {t("leaderboards.form.fields.cadence")}
            </label>
            <NativeSelect
              id={cadenceId}
              value={cadence}
              onChange={(e) => setCadence(e.target.value as LeaderboardCadence)}
              disabled={editing}
            >
              {CADENCE_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {t(CADENCE_LABEL_KEYS[c])}
                </option>
              ))}
            </NativeSelect>
            {editing && (
              <p className="text-[11px] leading-snug text-rv-mute-500">
                {t("leaderboards.form.cadence.locked")}
              </p>
            )}
          </div>
        </div>

        {metric === "TOP_CONSUMERS" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={currencyId2} className="text-[12px] font-medium text-foreground">
              {t("leaderboards.form.fields.currency")}
            </label>
            <NativeSelect
              id={currencyId2}
              value={currencyId}
              onChange={(e) => setCurrencyId(e.target.value)}
            >
              <option value="">{t("leaderboards.form.currency.allOption")}</option>
              {props.currencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </NativeSelect>
          </div>
        )}

        {/* customPeriodDays is only meaningful for the CUSTOM cadence -- see
            services/leaderboards/cadence.ts `validateCadence`. Shown only
            here, and only in create mode: cadence itself is locked on edit. */}
        {!editing && isCustomCadence && (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={customPeriodDaysId}
              className="text-[12px] font-medium text-foreground"
            >
              {t("leaderboards.form.fields.customPeriodDays")}
            </label>
            <Input
              id={customPeriodDaysId}
              type="number"
              min={MIN_CUSTOM_PERIOD_DAYS}
              step={1}
              value={customPeriodDays}
              onChange={(e) => setCustomPeriodDays(e.target.value)}
              aria-invalid={customPeriodDaysInvalid}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={timezoneId} className="text-[12px] font-medium text-foreground">
              {t("leaderboards.form.fields.timezone")}
            </label>
            <Input
              id={timezoneId}
              mono
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder={DEFAULT_TIMEZONE}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={entryLimitId} className="text-[12px] font-medium text-foreground">
              {t("leaderboards.form.fields.entryLimit")}
            </label>
            <Input
              id={entryLimitId}
              mono
              type="number"
              min={MIN_ENTRY_LIMIT}
              step={1}
              value={entryLimit}
              onChange={(e) => setEntryLimit(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-foreground">
            {t("leaderboards.form.fields.enabled")}
          </span>
          <div className="inline-flex w-fit items-center gap-3 rounded-md border border-rv-divider bg-rv-c1 px-3 py-2">
            <Switch
              checked={isEnabled}
              onChange={setIsEnabled}
              ariaLabel={t("leaderboards.form.fields.enabled")}
            />
            <span className="font-rv-mono text-[12px] tabular-nums text-rv-mute-700">
              {isEnabled ? t("common.active") : t("common.inactive")}
            </span>
          </div>
        </div>

        {error && (
          <p className="text-[12px] text-rv-danger" role="alert">
            {error}
          </p>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
        <Button type="button" variant="flat" size="sm" onClick={props.onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          variant="solid-primary"
          size="sm"
          disabled={submitDisabled}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </footer>
    </div>
  );
}
