import type { ReactNode } from "react";

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

// Placeholder renderer. Tasks 11-13 replace this with a per-tool
// switch that renders Approval / Subscriber / Metrics / Navigate cards.
// For now we dump the raw JSON so the conversation surface is wired
// end-to-end and devs can sanity-check the part shapes coming over the
// wire.
export function RoviToolUI({ part }: { part: ToolPart }): ReactNode {
  return (
    <pre className="overflow-auto rounded-md border border-rv-divider bg-rv-c2 p-2 text-[11px] text-rv-mute-700">
      {JSON.stringify(part, null, 2)}
    </pre>
  );
}
