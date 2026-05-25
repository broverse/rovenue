import { useTranslation } from "react-i18next";
import { Select } from "../../ui/select";
import { Field } from "./field";
import { StepHead } from "./step-head";
import {
  CURRENCIES,
  FISCAL_MONTHS,
  TIMEZONES,
} from "./mock-data";
import type {
  FiscalMonth,
  SetupForm,
  WeekStart,
} from "./types";

type StepCurrencyProps = {
  form: SetupForm;
  onUpdate: <Key extends keyof SetupForm>(key: Key, value: SetupForm[Key]) => void;
};

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

      <Field
        label={t("projectSetup.currency.fxSource")}
        hint={t("projectSetup.currency.fxSourceHint")}
      >
        <div className="flex items-center justify-between rounded-md border border-rv-divider bg-rv-c2 px-3 py-2.5">
          <div>
            <div className="text-[13px] font-medium text-foreground">
              {t("projectSetup.currency.fxOptions.ecb.name")}
            </div>
            <div className="text-[12px] text-rv-mute-600">
              {t("projectSetup.currency.fxOptions.ecb.desc")}
            </div>
          </div>
          <span className="rounded-sm bg-rv-c3 px-1.5 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
            {t("projectSetup.currency.fxLocked")}
          </span>
        </div>
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
    </>
  );
}
