import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CohortRow, CohortRule } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { ApiError } from "../../lib/api";
import {
  useCreateCohort,
  useUpdateCohort,
} from "../../lib/hooks/useProjectCohorts";
import { CohortRuleBuilder } from "./cohort-rule-builder";
import { sanitiseRule } from "./rule-codec";

type Props =
  | {
      mode: "create";
      projectId: string;
      onSuccess: (id: string) => void;
      onCancel: () => void;
    }
  | {
      mode: "edit";
      projectId: string;
      cohort: CohortRow;
      onSuccess: (id: string) => void;
      onCancel: () => void;
    };

const EMPTY_RULE: CohortRule = { match: "all", filters: [] };

export function CohortForm(props: Props) {
  const { t } = useTranslation();
  const initial = props.mode === "edit" ? props.cohort : null;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [rule, setRule] = useState<CohortRule>(initial?.rules ?? EMPTY_RULE);
  const [serverError, setServerError] = useState<string | null>(null);

  const create = useCreateCohort(props.projectId);
  const update = useUpdateCohort(props.projectId);
  const pending = create.isPending || update.isPending;

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !pending;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const payload = {
      name: trimmedName,
      description: description.trim() === "" ? null : description.trim(),
      rules: sanitiseRule(rule),
    };

    try {
      if (props.mode === "create") {
        const res = await create.mutateAsync(payload);
        props.onSuccess(res.cohort.id);
      } else {
        const res = await update.mutateAsync({
          id: props.cohort.id,
          ...payload,
        });
        props.onSuccess(res.cohort.id);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setServerError(t("cohorts.form.errors.nameInUse"));
      } else if (err instanceof Error) {
        setServerError(err.message);
      } else {
        setServerError(t("common.unknownError"));
      }
    }
  }

  const submitLabel =
    props.mode === "create"
      ? pending
        ? t("cohorts.form.submit.creating")
        : t("cohorts.form.submit.create")
      : pending
        ? t("cohorts.form.submit.saving")
        : t("cohorts.form.submit.save");

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <section className="rounded-lg border border-rv-divider bg-rv-c1">
        <header className="border-b border-rv-divider px-4 py-3">
          <h2 className="text-[13px] font-medium">
            {t("cohorts.form.basics.heading")}
          </h2>
        </header>
        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="flex flex-col gap-1 text-[12px] text-rv-mute-600">
            {t("cohorts.form.basics.name")}
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("cohorts.form.basics.namePlaceholder")}
              className="h-8 rounded border border-rv-divider bg-rv-c2 px-2 text-[13px] text-foreground"
            />
            {serverError && (
              <span className="text-[11px] text-rv-danger">{serverError}</span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-rv-mute-600">
            {t("cohorts.form.basics.description")}
            <textarea
              value={description ?? ""}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("cohorts.form.basics.descriptionPlaceholder")}
              rows={2}
              className="rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[13px] text-foreground"
            />
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-rv-divider bg-rv-c1">
        <header className="border-b border-rv-divider px-4 py-3">
          <h2 className="text-[13px] font-medium">
            {t("cohorts.form.rules.heading")}
          </h2>
        </header>
        <div className="flex flex-col gap-3 px-4 py-3">
          <CohortRuleBuilder rule={rule} onChange={setRule} />
          <details className="text-[11px] text-rv-mute-500">
            <summary className="cursor-pointer select-none">
              {t("cohorts.form.rules.preview")}
            </summary>
            <pre className="mt-1 overflow-auto rounded bg-rv-c2 p-2 font-rv-mono text-[11px] text-foreground">
              {JSON.stringify(sanitiseRule(rule), null, 2)}
            </pre>
          </details>
        </div>
      </section>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="flat"
          size="sm"
          onClick={props.onCancel}
        >
          {t("cohorts.form.submit.cancel")}
        </Button>
        <Button
          type="submit"
          variant="solid-primary"
          size="sm"
          disabled={!canSubmit}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
