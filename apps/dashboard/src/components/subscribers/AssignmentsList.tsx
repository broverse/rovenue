import { Chip } from "@heroui/react";
import type { SubscriberAssignment } from "@rovenue/shared";

interface Props {
  rows: SubscriberAssignment[];
}

export function AssignmentsList({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-default-500">
        Not in any active experiments.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((a) => (
        <li
          key={`${a.experimentId}-${a.variantId}`}
          className="flex items-center justify-between rounded-lg border border-default-200 p-3"
        >
          <div className="flex flex-col">
            <span className="font-semibold">{a.experimentKey}</span>
            <span className="text-xs text-default-500">
              variant {a.variantId}
            </span>
          </div>
          <Chip
            size="sm"
            color={a.convertedAt ? "success" : "default"}
          >
            {a.convertedAt ? "Converted" : "Active"}
          </Chip>
        </li>
      ))}
    </ul>
  );
}
