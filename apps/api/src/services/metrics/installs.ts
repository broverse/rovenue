import { drizzle } from "@rovenue/db";
import { and, count, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

// =============================================================
// Installs — the denominator behind `rev_per_install`
// =============================================================
//
// This file is the ONLY definition of what an install is: a
// `subscribers` row created by the SDK's public-key /v1 surface, dated
// by `sdkInstalledAt` (stamped insert-only in
// lib/resolve-or-create-subscriber.ts). NULL means the row came from
// somewhere else — the CSV importer, a store webhook, an S2S call —
// and is not an install.
//
// What the number MEANS, stated where it is produced rather than in a
// footnote nobody reads: this counts SUBSCRIBER first contact, not
// device installs. A reinstall that clears the SDK's local cache mints
// a new anonymous subscriber and counts again; one that restores the
// cache does not. Two subscribers later merged by
// /v1/subscribers/transfer stay two installs — merging identities is
// not an un-install.
//
// Soft-deleted rows are counted. GDPR erasure removes the person, and
// `anonymize-subscriber` clears `attributes` — but an install count is
// an aggregate carrying no identity, and a metric that silently shrank
// whenever someone exercised erasure would be reporting a different
// number every week for reasons no reader could see. That is the whole
// reason `sdkInstalledAt` is a column instead of a query over the
// `platform` attribute.
//
// Postgres, necessarily: `raw_revenue_events` only ever sees a
// subscriber who transacted, so ClickHouse cannot answer this at all.
// Like `trials_started` and `churn`, that places this reader outside
// schema-contract.integration.test.ts's reach —
// installs.integration.test.ts is its guard.

export interface DailyInstallCount {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  n: number;
}

export interface GetInstallsDailyInput {
  projectId: string;
  from: Date;
  to: Date;
}

/**
 * Installs per day for a project, sparse: a day with no installs has no
 * row (the caller widens onto every day in the window, the same
 * convention every other daily reader in this directory follows).
 */
export async function getInstallsDaily(
  input: GetInstallsDailyInput,
): Promise<DailyInstallCount[]> {
  const s = drizzle.schema.subscribers;
  const rows = await drizzle.db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${s.sdkInstalledAt}), 'YYYY-MM-DD')`,
      n: count(),
    })
    .from(s)
    .where(
      and(
        eq(s.projectId, input.projectId),
        isNotNull(s.sdkInstalledAt),
        gte(s.sdkInstalledAt, input.from),
        lte(s.sdkInstalledAt, input.to),
      ),
    )
    .groupBy(sql`date_trunc('day', ${s.sdkInstalledAt})`)
    .orderBy(sql`date_trunc('day', ${s.sdkInstalledAt})`);

  return rows.map((r) => ({ day: r.day, n: Number(r.n) }));
}
