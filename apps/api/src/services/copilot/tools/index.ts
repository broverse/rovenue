import { querySubscribersTools, type ToolContext } from "./query-subscribers";

export function loadTools(ctx: ToolContext) {
  return {
    ...querySubscribersTools(ctx),
  };
}

const STATIC_NAMES = [
  "query.subscribers.search",
  "query.subscribers.get",
] as const;

export function listToolNames(): string[] {
  return [...STATIC_NAMES];
}

export type { ToolContext };
