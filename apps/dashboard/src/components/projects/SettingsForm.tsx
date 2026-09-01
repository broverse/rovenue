import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import type { ProjectDetail, UpdateProjectRequest } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Field } from "../project-setup/field";
import { useUpdateProject } from "../../lib/hooks/useUpdateProject";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 400;
const HOLDOUT_PERCENTAGE_MIN = 0;
const HOLDOUT_PERCENTAGE_MAX = 100;

interface Props {
  project: ProjectDetail;
}

export function SettingsForm({ project }: Props) {
  const { t } = useTranslation();
  const initialDescription = useMemo(() => project.description ?? "", [project.description]);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(initialDescription);
  const [holdoutPercentage, setHoldoutPercentage] = useState(
    String(project.holdoutPercentage),
  );
  const { mutate, isPending, error } = useUpdateProject(project.id);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();

  // Empty/garbage input is treated as "no change yet" rather than 0 — an
  // accidentally-cleared field must not silently submit as "lower the
  // holdout to zero".
  const parsedHoldoutPercentage = Number.parseInt(holdoutPercentage, 10);
  const holdoutPercentageValid =
    holdoutPercentage.trim() !== "" &&
    Number.isInteger(parsedHoldoutPercentage) &&
    parsedHoldoutPercentage >= HOLDOUT_PERCENTAGE_MIN &&
    parsedHoldoutPercentage <= HOLDOUT_PERCENTAGE_MAX;
  const holdoutPercentageChanged =
    holdoutPercentageValid && parsedHoldoutPercentage !== project.holdoutPercentage;
  // Threshold bucketing (assignBucket below a cutoff) makes raising the
  // holdout safe — it only ever adds members — and lowering it lossy: it
  // drops members whose exposure is already recorded, mixing them back
  // into the general population mid-comparison. Only the lossy direction
  // gets a warning; both directions are still audited server-side.
  const isLoweringHoldout =
    holdoutPercentageChanged && parsedHoldoutPercentage < project.holdoutPercentage;

  const patch: UpdateProjectRequest = {};
  if (trimmedName && trimmedName !== project.name) patch.name = trimmedName;
  if (trimmedDescription !== (project.description ?? "")) {
    patch.description = trimmedDescription ? trimmedDescription : null;
  }
  if (holdoutPercentageChanged) patch.holdoutPercentage = parsedHoldoutPercentage;

  const hasChanges = Object.keys(patch).length > 0;
  const canSubmit = hasChanges && trimmedName.length >= 2 && holdoutPercentageValid;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    mutate(patch);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1">
      <Field
        label={t("projectSetup.basics.name")}
        optional={t("projectSetup.basics.required")}
        hint={t("projectSetup.basics.nameHint", {
          count: name.length,
          max: NAME_MAX,
        })}
      >
        <Input
          placeholder={t("projectSetup.basics.namePlaceholder")}
          value={name}
          maxLength={NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </Field>

      <Field
        label={t("projectSetup.basics.descLabel")}
        optional={t("projectSetup.basics.optional")}
        hint={t("projectSetup.basics.descriptionHint", {
          count: description.length,
          max: DESCRIPTION_MAX,
        })}
      >
        <Textarea
          placeholder={t("projectSetup.basics.descriptionPlaceholder")}
          value={description}
          maxLength={DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      <Field
        label={t("experiments.holdout.label")}
        hint={t("experiments.holdout.hint")}
        error={holdoutPercentage.trim() !== "" && !holdoutPercentageValid}
      >
        <Input
          type="number"
          inputMode="numeric"
          min={HOLDOUT_PERCENTAGE_MIN}
          max={HOLDOUT_PERCENTAGE_MAX}
          step={1}
          value={holdoutPercentage}
          onChange={(event) => setHoldoutPercentage(event.target.value)}
        />
      </Field>

      {isLoweringHoldout && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-rv-warning/30 bg-rv-warning/[0.08] px-3 py-2.5">
          <TriangleAlert size={14} className="mt-0.5 flex-shrink-0 text-rv-warning" />
          <p className="m-0 text-[12px] leading-relaxed text-rv-mute-700">
            {t("experiments.holdout.loweringWarning")}
          </p>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-3 text-sm text-rv-danger">
          {error.message}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="submit"
          variant="solid-primary"
          size="md"
          disabled={!canSubmit || isPending}
        >
          {t("common.saveChanges")}
        </Button>
        {!hasChanges && (
          <span className="text-xs text-rv-mute-500">{t("common.noChanges")}</span>
        )}
      </div>
    </form>
  );
}
