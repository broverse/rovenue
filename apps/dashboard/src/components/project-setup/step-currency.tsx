import { useTranslation } from "react-i18next";
import { Select } from "../../ui/select";
import { CardPick, CardPickGrid } from "./card-pick";
import { Field } from "./field";
import { StepHead } from "./step-head";
import { ToggleRow } from "./toggle-row";
import {
  CURRENCIES,
  FISCAL_MONTHS,
  TIMEZONES,
} from "./mock-data";
import type {
  FiscalMonth,
  FxSourceId,
  RefundPolicy,
  SetupForm,
  WeekStart,
} from "./types";

type StepCurrencyProps = {
  form: SetupForm;
  onUpdate: <Key extends keyof SetupForm>(key: Key, value: SetupForm[Key]) => void;
};

const FX_SOURCES: ReadonlyArray<FxSourceId> = ["ecb", "oanda", "custom"];
const REFUND_POLICIES: ReadonlyArray<RefundPolicy> = [
  "partial-window",
  "full-clawback",
];
const WEEK_STARTS: ReadonlyArray<WeekStart> = [
  "monday",
  "sunday",
  "saturday",
];

export function StepCurrency({ form, onUpdate }: StepCurrencyProps) {
  const { t } = useTranslation();

  return (
    <>
      <StepHead
        eyebrow={t("projectSetup.currency.eyebrow")}
        title={t("projectSetup.currency.title")}
        description={t("projectSetup.currency.description")}
      />

      <Field
        label={t("projectSetup.currency.reportingCurrency")}
        optional={t("projectSetup.basics.required")}
        hint={t("projectSetup.currency.reportingCurrencyHint")}
      >
        <Select
          value={form.currency}
          onChange={(event) => onUpdate("currency", event.target.value)}
        >
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={t("projectSetup.currency.fxSource")}>
        <CardPickGrid columns={3}>
          {FX_SOURCES.map((source) => (
            <CardPick
              key={source}
              selected={form.fxSource === source}
              onSelect={() => onUpdate("fxSource", source)}
              title={t(`projectSetup.currency.fxOptions.${source}.name`)}
              description={t(`projectSetup.currency.fxOptions.${source}.desc`)}
            />
          ))}
        </CardPickGrid>
      </Field>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <Field
          className="mb-0"
          label={t("projectSetup.currency.timezone")}
          optional={t("projectSetup.basics.required")}
          hint={t("projectSetup.currency.timezoneHint")}
        >
          <Select
            value={form.timezone}
            onChange={(event) => onUpdate("timezone", event.target.value)}
          >
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
        <Field className="mb-0" label={t("projectSetup.currency.weekStart")}>
          <Select
            value={form.weekStart}
            onChange={(event) =>
              onUpdate("weekStart", event.target.value as WeekStart)
            }
          >
            {WEEK_STARTS.map((option) => (
              <option key={option} value={option}>
                {t(`projectSetup.currency.weekOptions.${option}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        className="mt-3.5"
        label={t("projectSetup.currency.fiscalYear")}
        optional={t("projectSetup.currency.fiscalYearOptional")}
      >
        <Select
          value={form.fiscalMonth}
          onChange={(event) =>
            onUpdate("fiscalMonth", event.target.value as FiscalMonth)
          }
        >
          {FISCAL_MONTHS.map((month) => (
            <option key={month} value={month}>
              {t(`projectSetup.currency.months.${month}`)}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label={t("projectSetup.currency.refundPolicy")}
        optional={t("projectSetup.currency.refundPolicyOptional")}
      >
        <CardPickGrid>
          {REFUND_POLICIES.map((policy) => (
            <CardPick
              key={policy}
              selected={form.refundPolicy === policy}
              onSelect={() => onUpdate("refundPolicy", policy)}
              title={t(`projectSetup.currency.refundOptions.${policy}.name`)}
              description={t(`projectSetup.currency.refundOptions.${policy}.desc`)}
            />
          ))}
        </CardPickGrid>
      </Field>

      <ToggleRow
        title={t("projectSetup.currency.autoImport.title")}
        description={t("projectSetup.currency.autoImport.description")}
        checked={form.autoImport}
        onChange={(next) => onUpdate("autoImport", next)}
      />
    </>
  );
}
