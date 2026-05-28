import type { ReactNode } from "react";
import { ApprovalCard } from "./tools/approval-card";

// Shape of a v6 tool UI part as we expect to receive it from the
// `useChat` SSE stream. The narrow `tool-${string}` template gives us
// future inference room (Task 11+) while still allowing the loose
// `string` fallback so we can hand-roll part objects in tests/storybook
// without fighting the type checker.
export type ToolPart = {
  type: `tool-${string}` | string;
  toolName?: string;
  state?:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error"
    | string;
  input?: unknown;
  output?: unknown;
};

// Per-tool renderer. `action.*` tools surface an inline approval card
// (Task 11); subscriber / metrics / navigate renderers land in Tasks
// 12-13. Anything else falls back to the raw JSON dump so devs can
// still inspect unmodelled tool shapes coming over the wire.
export function RoviToolUI({ part }: { part: ToolPart }): ReactNode {
  const name = part.toolName ?? "";
  if (
    name.startsWith("action.") &&
    part.output &&
    typeof part.output === "object"
  ) {
    return <ApprovalCard intent={part.output as never} />;
  }
  return (
    <pre className="overflow-auto rounded-md border border-rv-divider bg-rv-c2 p-2 text-[11px] text-rv-mute-700">
      {JSON.stringify(part, null, 2)}
    </pre>
  );
}
