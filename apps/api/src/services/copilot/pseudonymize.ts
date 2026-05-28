const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export type SubscriberResolver = (
  projectId: string,
  email: string,
) => Promise<string | null>;

export interface PseudonymizeInput {
  projectId: string;
  input: string;
  resolveByEmail: SubscriberResolver;
}

export interface PseudonymizeResult {
  text: string;
  mapping: Map<string, string>;
}

export async function pseudonymizeMessage(
  args: PseudonymizeInput,
): Promise<PseudonymizeResult> {
  const mapping = new Map<string, string>();
  const matches = Array.from(args.input.matchAll(EMAIL_RE)).map((m) => m[0]);
  const unique = Array.from(new Set(matches.map((e) => e.toLowerCase())));

  for (const email of unique) {
    const id = await args.resolveByEmail(args.projectId, email);
    if (id) mapping.set(email, id);
  }

  let text = args.input;
  for (const [email, id] of mapping) {
    const re = new RegExp(
      email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    text = text.replace(re, id);
  }

  return { text, mapping };
}
