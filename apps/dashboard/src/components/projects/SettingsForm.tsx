import { useMemo, useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { useTranslation } from "react-i18next";
import type { ProjectDetail, UpdateProjectRequest } from "@rovenue/shared";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Field } from "../project-setup/field";
import { useUpdateProject } from "../../lib/hooks/useUpdateProject";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 400;

interface Props {
  project: ProjectDetail;
}

export function SettingsForm({ project }: Props) {
  const { t } = useTranslation();
  const initialDescription = useMemo(() => project.description ?? "", [project.description]);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(initialDescription);
  const { mutate, isPending, error } = useUpdateProject(project.id);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();

  const patch: UpdateProjectRequest = {};
  if (trimmedName && trimmedName !== project.name) patch.name = trimmedName;
  if (trimmedDescription !== (project.description ?? "")) {
    patch.description = trimmedDescription ? trimmedDescription : null;
  }

  const hasChanges = Object.keys(patch).length > 0;
  const canSubmit = hasChanges && trimmedName.length >= 2;

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
          isDisabled={!canSubmit}
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
