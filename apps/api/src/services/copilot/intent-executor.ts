// =============================================================
// Intent executor
// =============================================================
//
// Maintains a registry of tool-name → handler mappings. The chat
// route calls `executeIntent()` after the AI emits an action.* tool
// call; the handler runs the mutation inside a DB transaction and
// writes the audit row atomically.

export interface IntentExecCtx {
  projectId: string;
  userId: string;
  role: string;
}

export type IntentHandler = (
  ctx: IntentExecCtx,
  payload: unknown,
) => Promise<unknown>;

const HANDLERS = new Map<string, IntentHandler>();

export function registerIntentHandler(name: string, handler: IntentHandler) {
  HANDLERS.set(name, handler);
}

export async function executeIntent(args: {
  intent: { id: string; toolName: string; payload: unknown };
  ctx: IntentExecCtx;
}): Promise<unknown> {
  const handler = HANDLERS.get(args.intent.toolName);
  if (!handler) {
    throw new Error(`No handler registered for ${args.intent.toolName}`);
  }
  return handler(args.ctx, args.intent.payload);
}

// =============================================================
// Test reset hook — not part of the public API
// =============================================================

export function __resetIntentHandlersForTests(): void {
  HANDLERS.clear();
}
