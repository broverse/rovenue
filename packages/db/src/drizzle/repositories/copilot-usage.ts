import { and, eq, sql } from "drizzle-orm";
import { type Db } from "../client";
import { copilotUsageMonthly } from "../schema";

export type CopilotUsageRow = typeof copilotUsageMonthly.$inferSelect;

export function currentYearMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getUsage(
  db: Db,
  projectId: string,
  yearMonth: string,
): Promise<CopilotUsageRow | null> {
  const [row] = await db
    .select()
    .from(copilotUsageMonthly)
    .where(
      and(
        eq(copilotUsageMonthly.projectId, projectId),
        eq(copilotUsageMonthly.yearMonth, yearMonth),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function bumpUsage(
  db: Db,
  input: {
    projectId: string;
    yearMonth: string;
    messages?: number;
    inputTokens?: number;
    outputTokens?: number;
  },
): Promise<void> {
  const { projectId, yearMonth } = input;
  const dm = input.messages ?? 0;
  const di = input.inputTokens ?? 0;
  const dout = input.outputTokens ?? 0;
  await db
    .insert(copilotUsageMonthly)
    .values({
      projectId,
      yearMonth,
      messages: dm,
      inputTokens: di,
      outputTokens: dout,
    })
    .onConflictDoUpdate({
      target: [copilotUsageMonthly.projectId, copilotUsageMonthly.yearMonth],
      set: {
        messages: sql`${copilotUsageMonthly.messages} + ${dm}`,
        inputTokens: sql`${copilotUsageMonthly.inputTokens} + ${di}`,
        outputTokens: sql`${copilotUsageMonthly.outputTokens} + ${dout}`,
        lastUpdated: new Date(),
      },
    });
}
