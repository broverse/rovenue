import { useState } from "react";
import {
  Button,
  Input,
  Label,
  TextField,
} from "@heroui/react";
import { useTranslation } from "react-i18next";
import type { ProjectDetail, UpdateProjectRequest } from "@rovenue/shared";
import { useUpdateProject } from "../../lib/hooks/useUpdateProject";

interface Props {
  project: ProjectDetail;
}

export function SettingsForm({ project }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(project.name);
  const { mutate, isPending, error } = useUpdateProject(project.id);

  const trimmedName = name.trim();

  const patch: UpdateProjectRequest = {};
  if (trimmedName && trimmedName !== project.name) patch.name = trimmedName;

  const hasChanges = Object.keys(patch).length > 0;
  const canSubmit = hasChanges && trimmedName.length >= 2;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        mutate(patch);
      }}
      className="flex flex-col gap-4"
    >
      <TextField value={name} onChange={setName} isRequired>
        <Label>{t("projects.form.name")}</Label>
        <Input placeholder={t("projects.form.namePlaceholder")} />
      </TextField>
      {error && (
        <div role="alert" className="text-sm text-danger-500">
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
