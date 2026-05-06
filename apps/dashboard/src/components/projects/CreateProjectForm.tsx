import { useState } from "react";
import {
  Button,
  Description,
  Input,
  Label,
  TextField,
} from "@heroui/react";
import { useTranslation } from "react-i18next";
import type { CreateProjectResponse } from "@rovenue/shared";
import { useCreateProject } from "../../lib/hooks/useCreateProject";

interface Props {
  onCreated: (result: CreateProjectResponse) => void;
}

export function CreateProjectForm({ onCreated }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const { mutate, isPending, error } = useCreateProject();

  const canSubmit = name.length >= 2 && /^[a-z0-9-]{2,80}$/.test(slug);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        mutate({ name, slug }, { onSuccess: onCreated });
      }}
      className="flex flex-col gap-4"
    >
      <TextField value={name} onChange={setName} isRequired>
        <Label>{t("projects.form.name")}</Label>
        <Input placeholder={t("projects.form.namePlaceholder")} />
      </TextField>
      <TextField value={slug} onChange={setSlug} isRequired>
        <Label>{t("projects.form.slug")}</Label>
        <Input placeholder={t("projects.form.slugPlaceholder")} />
        <Description>{t("projects.form.slugDescription")}</Description>
      </TextField>
      {error && (
        <div role="alert" className="text-sm text-danger-500">
          {error.message}
        </div>
      )}
      <Button
        type="submit"
        variant="primary"
        isPending={isPending}
        isDisabled={!canSubmit}
      >
        {t("projects.form.createProject")}
      </Button>
    </form>
  );
}
