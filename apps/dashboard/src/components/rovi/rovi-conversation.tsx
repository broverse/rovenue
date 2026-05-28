import type { UIMessage } from "ai";
import { RoviToolUI, type ToolPart } from "./rovi-tool-ui";

// Renders the running transcript from `useRoviChat`. We map straight
// over `message.parts` so reasoning / text / tool-* parts coexist in
// stream order. Tool parts hand off to `RoviToolUI` (a placeholder for
// now — Tasks 11-13 replace it with real per-tool cards).
//
// Plain-divs by design: we deliberately avoid `ai-elements`'
// `<Conversation>` / `<Message>` primitives here so Task 7 stays
// self-contained and we don't pin the UI shell to a fast-moving API.
export function RoviConversation({ messages }: { messages: UIMessage[] }) {
  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.map((m) => (
        <article
          key={m.id}
          className={
            m.role === "user"
              ? "rounded-md bg-rv-c2 px-3 py-2 text-sm text-foreground"
              : "text-sm text-foreground"
          }
        >
          {m.parts?.map((p, i) => {
            if (p.type === "text") {
              return (
                <p
                  key={i}
                  className="whitespace-pre-wrap leading-relaxed"
                >
                  {p.text}
                </p>
              );
            }
            if (typeof p.type === "string" && p.type.startsWith("tool-")) {
              return (
                <RoviToolUI
                  key={i}
                  part={p as unknown as ToolPart}
                />
              );
            }
            return null;
          })}
        </article>
      ))}
    </div>
  );
}
