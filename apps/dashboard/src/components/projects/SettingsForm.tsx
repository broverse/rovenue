import { useState } from "react";
import {
  Button,
  Description,
  Input,
  Label,
  TextField,
} from "@heroui/react";
import type { ProjectDetail, UpdateProjectRequest } from "@rovenue/shared";
import { useUpdateProject } from "../../lib/hooks/useUpdateProject";

interface Props {
  project: ProjectDetail;
}

export function SettingsForm({ project }: Props) {
  const [name, setName] = useState(project.name);
  const [webhookUrl, setWebhookUrl] = useState(project.webhookUrl ?? "");
  const { mutate, isPending, error } = useUpdateProject(project.id);

  const trimmedName = name.trim();
  const trimmedUrl = webhookUrl.trim();
  const originalUrl = project.webhookUrl ?? "";

  const patch: UpdateProjectRequest = {};
  if (trimmedName && trimmedName !== project.name) patch.name = trimmedName;
  if (trimmedUrl !== originalUrl) patch.webhookUrl = trimmedUrl ? trimmedUrl : null;

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
        <Label>Project name</Label>
        <Input placeholder="Acme" />
      </TextField>
      <TextField value={webhookUrl} onChange={setWebhookUrl}>
        <Label>Webhook URL</Label>
        <Input placeholder="https://example.com/hooks/rovenue" />
        <Description>
          Outgoing webhooks post here. Leave blank to disable delivery.
        </Description>
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
          Save changes
        </Button>
        {!hasChanges && (
          <span className="text-xs text-default-500">No changes to save.</span>
        )}
      </div>
    </form>
  );
}
