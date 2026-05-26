import { useMemo, useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { useTranslation } from "react-i18next";
import type {
  ProjectDetail,
  ProjectReportingSettings,
} from "@rovenue/shared";
import { Select } from "../../ui/select";
import { Field } from "../project-setup/field";
import {
  CURRENCIES,
  FISCAL_MONTHS,
  TIMEZONES,
} from "../project-setup/mock-data";
import type { FiscalMonth, WeekStart } from "../project-setup/types";
import { useUpdateProject } from "../../lib/hooks/useUpdateProject";

const WEEK_STARTS: ReadonlyArray<WeekStart> = ["monday", "sunday", "saturday"];

const DEFAULTS: ProjectReportingSettings = {
  reportingCurrency: "USD",
  fxSource: "ecb",
  timezone: "UTC",
  weekStart: "monday",
  fiscalMonth: "jan",
};

// Project.settings is opaque JSON; the wizard stores reporting defaults
// under settings.reporting. Normalize any missing field back to the
// system default so the form always renders against a complete shape.
function readReporting(
  settings: Record<string, unknown>,
): ProjectReportingSettings {
  const raw = (settings.reporting as Partial<ProjectReportingSettings> | undefined) ?? {};
  return {
    reportingCurrency: raw.reportingCurrency ?? DEFAULTS.reportingCurrency,
    fxSource: "ecb",
    timezone: raw.timezone ?? DEFAULTS.timezone,
    weekStart: raw.weekStart ?? DEFAULTS.weekStart,
    fiscalMonth: raw.fiscalMonth ?? DEFAULTS.fiscalMonth,
  };
}

interface Props {
  project: ProjectDetail;
}

export function ReportingForm({ project }: Props) {
  const { t } = useTranslation();
  const initial = useMemo(() => readReporting(project.settings), [project.settings]);
  const [form, setForm] = useState<ProjectReportingSettings>(initial);
  const { mutate, isPending, error } = useUpdateProject(project.id);

  const hasChanges =
    form.reportingCurrency !== initial.reportingCurrency ||
    form.timezone !== initial.timezone ||
    form.weekStart !== initial.weekStart ||
    form.fiscalMonth !== initial.fiscalMonth;

  function update<Key extends keyof ProjectReportingSettings>(
    key: Key,
    value: ProjectReportingSettings[Key],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasChanges) return;
    mutate({
      settings: { ...project.settings, reporting: form },
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1">
      <Field
        label={t("projectSetup.currency.reportingCurrency")}
        optional={t("projectSetup.basics.required")}
        hint={t("projectSetup.currency.reportingCurrencyHint")}
      >
        <Select
          value={form.reportingCurrency}
          onChange={(event) => update("reportingCurrency", event.target.value)}
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
          className="mb-5"
          label={t("projectSetup.currency.timezone")}
          optional={t("projectSetup.basics.required")}
          hint={t("projectSetup.currency.timezoneHint")}
        >
          <Select
            value={form.timezone}
            onChange={(event) => update("timezone", event.target.value)}
          >
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
        <Field className="mb-5" label={t("projectSetup.currency.weekStart")}>
          <Select
            value={form.weekStart}
            onChange={(event) =>
              update("weekStart", event.target.value as WeekStart)
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
        label={t("projectSetup.currency.fiscalYear")}
        optional={t("projectSetup.currency.fiscalYearOptional")}
      >
        <Select
          value={form.fiscalMonth}
          onChange={(event) =>
            update("fiscalMonth", event.target.value as FiscalMonth)
          }
        >
          {FISCAL_MONTHS.map((month) => (
            <option key={month} value={month}>
              {t(`projectSetup.currency.months.${month}`)}
            </option>
          ))}
        </Select>
      </Field>

      {error && (
        <div role="alert" className="mb-3 text-sm text-danger-500">
          {error.message}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          isPending={isPending}
          isDisabled={!hasChanges}
        >
          {t("common.saveChanges")}
        </Button>
        {!hasChanges && (
          <span className="text-xs text-default-500">{t("common.noChanges")}</span>
        )}
      </div>
    </form>
  );
}
