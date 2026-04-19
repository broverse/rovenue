import { useState } from "react";
import {
  Button,
  Description,
  Input,
  Label,
  TextField,
} from "@heroui/react";
import type { CreateProjectResponse } from "@rovenue/shared";
import { useCreateProject } from "../../lib/hooks/useCreateProject";

interface Props {
  onCreated: (result: CreateProjectResponse) => void;
}

export function CreateProjectForm({ onCreated }: Props) {
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
        <Label>Project name</Label>
        <Input placeholder="Acme" />
      </TextField>
      <TextField value={slug} onChange={setSlug} isRequired>
        <Label>Slug</Label>
        <Input placeholder="acme" />
        <Description>Lowercase letters, numbers, and dashes only</Description>
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
        Create project
      </Button>
    </form>
  );
}
