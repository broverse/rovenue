# Paywall & Funnel Server-Side Authoring Paths — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give paywall tree edits a durable server-side write path with optimistic concurrency, and put every paywall/funnel mutation behind one capability gate, so clients other than the dashboard builder can author safely.

**Architecture:** The paywall draft (`paywalls.builderConfig`) gains a monotonic `draftRevision` guard; the `action_paywall_editTree` intent handler stops being a dry run and becomes the sole persister for approved ops; two new capabilities (`paywalls:write`, `funnels:write`) replace the rank gates on paywall/funnel mutations; per-type funnel page rules join the existing publish-time graph validation in `@rovenue/shared/funnel`.

**Tech Stack:** Hono, TypeScript strict, Drizzle ORM + Postgres 16, Zod, Vitest (+ testcontainers for integration), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-07-paywall-funnel-authoring-paths-design.md`

## Global Constraints

- **Stay on the current branch.** Do not create, switch, or delete branches or worktrees. The user manages branching.
- **No magic values.** Hoist literals into named constants. (Structured data tables — e.g. the capability→roles map — are not magic values.)
- **Throttle test runs.** Use `nice -n 19 npx vitest run --maxWorkers=2` from the relevant package directory. Never run the full suite in parallel with a build. Builds: `--concurrency=2`.
- **TypeScript strict everywhere.** Zod for API input. All responses are `{ data: T }` or `{ error: { code, message } }`.
- **Postgres access via Drizzle only** — repositories under `packages/db/src/drizzle/repositories`. In raw `sql`, qualify columns (`"paywalls"."id"`).
- **`audit()` runs inside the caller's transaction.** Never open a second transaction for the audit row.
- **Capability role sets are fixed by the spec — copy verbatim:**
  - `paywalls:write` → `["OWNER", "ADMIN", "DEVELOPER"]`
  - `funnels:write` → `["OWNER", "ADMIN", "DEVELOPER", "GROWTH"]`
- **Revision mismatch is HTTP 409.** No merge, ever.
- **Funnel per-type validation runs at publish, never at save.** Saving an invalid page must keep succeeding.
- **Every new migration must be checked against the drizzle journal watermark** before the task is considered done (see Task 3, Step 6). Migrations that land below the watermark are silently skipped forever on upgrade-path databases.
- **Do not run `pnpm db:migrate:fresh` against a database with existing history.**
- **Before every commit, run `git status --porcelain` and confirm no file you changed is left unstaged.** The `git add` lines in these tasks name paths explicitly and one of them has already proved incomplete — a task whose commit omits a file it edited does not compile at that commit, even though it compiles in your working tree.
- **New DB columns follow the target table's own naming convention.** `copilot_intents` and most hot tables are snake_case; naming is genuinely mixed *across* tables, so read the table before adding to it rather than generalising.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/lib/capabilities.ts` | Add `paywalls:write`, `funnels:write` to the `Capability` union and `CAPABILITY_ROLES` | 1 |
| `apps/api/src/lib/capabilities.test.ts` | Pin both role sets | 1 |
| `packages/db/src/drizzle/schema.ts` | `paywalls.draftRevision`; `copilotIntents.requiresCapability` | 2, 3 |
| `packages/db/drizzle/<n>_*.sql` | Migrations for both columns | 2, 3 |
| `apps/api/src/services/copilot/tools/_action-helper.ts` | Optional `requiresCapability` on intent creation | 2 |
| `apps/api/src/routes/dashboard/copilot/intents.ts` | Capability gate when the intent declares one | 2 |
| `apps/api/src/services/copilot/tools/action-paywall.ts` | Declare `requiresCapability: "paywalls:write"` | 2 |
| `apps/api/src/routes/dashboard/paywalls.ts` | `products:write` → `paywalls:write`; accept + enforce `draftRevision` | 2, 4 |
| `packages/db/src/drizzle/repositories/paywalls.ts` | `updatePaywallDraft` — compare-and-swap on `draftRevision` | 4 |
| `apps/api/src/services/copilot/intent-handlers.ts` | `action_paywall_editTree` persists | 5 |
| `apps/dashboard/src/**` (builder) | Stop client-side applying an approved op; send `draftRevision` on autosave | 5, 4 |
| `packages/shared/src/funnel/page-fields.ts` | **New.** Per-type page field rules | 6 |
| `packages/shared/src/funnel/index.ts` | Barrel export for the above | 6 |
| `apps/api/src/routes/dashboard/funnels.ts` | Rank gate → `funnels:write`; run per-type rules at publish | 7 |
| `apps/api/src/scripts/measure-funnel-page-rules.ts` | **New.** M1 measurement over published funnels | 8 |
| `apps/api/src/routes/dashboard/authorization-surface.test.ts` | **New.** Structural guard: every paywall/funnel mutation route is capability-gated | 9 |

---

### Task 1: Define the two capabilities

Nothing consumes them yet. This task exists on its own because a reviewer
can reject the role sets without touching any behaviour.

**Files:**
- Modify: `apps/api/src/lib/capabilities.ts`
- Test: `apps/api/src/lib/capabilities.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Capability` union gains `"paywalls:write"` and `"funnels:write"`; `roleHasCapability(role, cap)` and `assertProjectCapability(projectId, userId, cap)` accept them.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/lib/capabilities.test.ts` (create the file with the
imports below if it does not exist):

```ts
import { describe, expect, it } from "vitest";
import { MemberRole } from "@rovenue/db";
import { roleHasCapability } from "./capabilities";

const ALL_ROLES: MemberRole[] = [
  "OWNER",
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
] as MemberRole[];

describe("paywalls:write / funnels:write role sets", () => {
  // Pinned by the design spec. `paywalls:write` mirrors what
  // PATCH /paywalls/:id already enforced via products:write.
  it("paywalls:write admits exactly OWNER, ADMIN, DEVELOPER", () => {
    const admitted = ALL_ROLES.filter((r) =>
      roleHasCapability(r, "paywalls:write"),
    );
    expect(admitted).toEqual(["OWNER", "ADMIN", "DEVELOPER"]);
  });

  // Mirrors exactly the set today's DEVELOPER *rank* gate admits on
  // funnel routes — GROWTH shares DEVELOPER's rank. Nobody loses access.
  it("funnels:write admits exactly OWNER, ADMIN, DEVELOPER, GROWTH", () => {
    const admitted = ALL_ROLES.filter((r) =>
      roleHasCapability(r, "funnels:write"),
    );
    expect(admitted).toEqual(["OWNER", "ADMIN", "DEVELOPER", "GROWTH"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && nice -n 19 npx vitest run src/lib/capabilities.test.ts --maxWorkers=2
```

Expected: FAIL — TypeScript rejects `"paywalls:write"` as it is not in the `Capability` union.

- [ ] **Step 3: Add the capabilities**

In `apps/api/src/lib/capabilities.ts`, add to the `Capability` union, directly after `"products:write"`:

```ts
  | "paywalls:write"
  | "funnels:write"
```

And to `CAPABILITY_ROLES`, directly after the `"products:write"` row:

```ts
  // Paywall builder writes. Same set as products:write, which is what
  // PATCH /paywalls/:id already enforced; naming it separately lets the
  // intent-execute path share ONE gate with the REST route instead of
  // approximating it with a rank (see design spec, D3).
  "paywalls:write":         ["OWNER", "ADMIN", "DEVELOPER"],
  // Funnel writes. Exactly the set the DEVELOPER *rank* gate already
  // admits — ROLE_RANK gives GROWTH the same rank as DEVELOPER — so this
  // is a faithful restatement, not a policy change. The resulting
  // asymmetry (GROWTH may author a funnel but not a paywall) is a known
  // product question, recorded in the design spec.
  "funnels:write":          ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && nice -n 19 npx vitest run src/lib/capabilities.test.ts --maxWorkers=2
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/capabilities.ts apps/api/src/lib/capabilities.test.ts
git commit -m "feat(api): add paywalls:write and funnels:write capabilities"
```

---

### Task 2: Let an intent declare a capability, and point paywall edits at it

**Refines the spec.** The spec says every paywall mutation path routes
through `assertProjectCapability`. One of those paths is the intent
execute route, which today gates on `assertProjectAccess(projectId,
userId, intent.requiresRole)` — a *rank*. Changing that call outright
would re-gate every other action tool too. Instead the intent row gains an
optional `requiresCapability`; when set it is authoritative, when null the
existing rank gate is untouched. Additive, and no other tool changes.

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (`copilotIntents`)
- Create: `packages/db/drizzle/migrations/<next>_copilot_intent_requires_capability.sql`
- Modify: `packages/db/src/drizzle/repositories/copilot-intents.ts`
- Modify: `apps/api/src/services/copilot/tools/_action-helper.ts`
- Modify: `apps/api/src/services/copilot/tools/action-paywall.ts`
- Modify: `apps/api/src/routes/dashboard/copilot/intents.ts`
- Modify: `apps/api/src/routes/dashboard/paywalls.ts`
- Test: `apps/api/src/routes/dashboard/copilot/copilot-rbac.integration.test.ts`

**Interfaces:**
- Consumes: `Capability`, `assertProjectCapability` (Task 1).
- Produces: `createIntentTool({ ..., requiresCapability?: Capability })`; `copilotIntents.requiresCapability: text | null`.

- [ ] **Step 1: Write the failing test**

`copilot-rbac.integration.test.ts` has only `buildApp()` — the two
helpers below **do not exist yet and must be written in this step**,
modelled on the inline seeding already in that file:

```ts
// Creates a user + Better Auth session, a project, and a membership with
// the given role, plus one paywall in that project.
async function seedProjectWithRole(
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT",
): Promise<{ cookie: string; projectId: string; userId: string; paywallId: string }>;

// Inserts a pending copilot_intents row for action_paywall_editTree whose
// payload is a valid tree op against that paywall, and whose
// requiresCapability is "paywalls:write".
async function seedPaywallEditIntent(
  args: { projectId: string; paywallId: string },
): Promise<string>; // returns the intent id
```

Then append:

```ts
it("a DEVELOPER may execute a paywall edit intent (capability gate)", async () => {
  // Before this change the intent carried requiresRole "ADMIN" — the
  // tightest RANK that was a subset of products:write — which excluded
  // DEVELOPER even though PATCH /paywalls/:id has always allowed it.
  const { cookie, projectId, paywallId } = await seedProjectWithRole("DEVELOPER");
  const intentId = await seedPaywallEditIntent({ projectId, paywallId });

  const res = await app.request(
    `/projects/${projectId}/copilot/intents/${intentId}/execute`,
    { method: "POST", headers: { cookie } },
  );

  expect(res.status).toBe(200);
});

it("a GROWTH member may NOT execute a paywall edit intent", async () => {
  // GROWTH shares DEVELOPER's rank, so a rank gate could not express
  // this exclusion. The capability gate can.
  const { cookie, projectId, paywallId } = await seedProjectWithRole("GROWTH");
  const intentId = await seedPaywallEditIntent({ projectId, paywallId });

  const res = await app.request(
    `/projects/${projectId}/copilot/intents/${intentId}/execute`,
    { method: "POST", headers: { cookie } },
  );

  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker ps   # Postgres testcontainer needs Docker up; vitest hangs otherwise
cd apps/api && nice -n 19 npx vitest run src/routes/dashboard/copilot/copilot-rbac.integration.test.ts --maxWorkers=2
```

Expected: FAIL — the DEVELOPER case returns 403 under the current ADMIN rank gate.

- [ ] **Step 3: Add the column**

In `packages/db/src/drizzle/schema.ts`, inside the `copilotIntents` table definition, directly after `requiresRole`:

```ts
    // When set, this capability is the authoritative gate at execute time
    // and `requiresRole` is ignored. Null keeps the legacy rank gate, so
    // action tools that have not migrated are unaffected.
    requiresCapability: text("requires_capability"),
```

Generate the migration:

```bash
pnpm db:migrate:generate
```

Then run the **journal watermark check** from Task 3, Step 6 against this
migration too. Every new migration in this repo needs it, not just the
last one — a migration below the watermark is skipped forever on
upgrade-path databases.

- [ ] **Step 4: Thread it through creation**

In `apps/api/src/services/copilot/tools/_action-helper.ts`, add to the `createIntentTool` args type and pass it to `createIntent`:

```ts
  requiresRole: string;
  requiresCapability?: Capability;
```

```ts
        requiresRole: args.requiresRole,
        requiresCapability: args.requiresCapability ?? null,
```

Import the type at the top:

```ts
import type { Capability } from "../../../lib/capabilities";
```

In `apps/api/src/services/copilot/tools/action-paywall.ts`, on the
`action_paywall_editTree` `createIntentTool` call, add:

```ts
      requiresCapability: "paywalls:write",
```

Leave `requiresRole: "ADMIN"` in place — it is now the fallback that never
fires for this tool, and removing it would break the not-null column.

- [ ] **Step 5: Use it at execute time**

In `apps/api/src/routes/dashboard/copilot/intents.ts`, replace the
membership assertion inside `POST /:id/execute`:

```ts
    const membership = intent.requiresCapability
      ? await assertProjectCapability(
          projectId,
          user.id,
          intent.requiresCapability as Capability,
        )
      : await assertProjectAccess(
          projectId,
          user.id,
          intent.requiresRole as MemberRole,
        );
```

Add the imports:

```ts
import { assertProjectCapability, type Capability } from "../../../lib/capabilities";
```

- [ ] **Step 6: Point the REST route at the new capability**

In `apps/api/src/routes/dashboard/paywalls.ts`, replace every
`assertProjectCapability(projectId, user.id, "products:write")` with
`assertProjectCapability(projectId, user.id, "paywalls:write")`.

```bash
grep -n '"products:write"' apps/api/src/routes/dashboard/paywalls.ts
```

Expected after the edit: no matches.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/dashboard/copilot/copilot-rbac.integration.test.ts src/routes/dashboard/paywalls --maxWorkers=2
```

Expected: PASS, including the pre-existing paywall route tests.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle apps/api/src
git commit -m "feat(api): gate paywall writes on paywalls:write via intent capability"
```

---

### Task 3: `draftRevision` column on `paywalls`

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (`paywalls`)
- Create: `packages/db/drizzle/migrations/<next>_paywall_draft_revision.sql`
- Test: `packages/db/src/drizzle/drizzle-foundation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `paywalls.draftRevision: integer NOT NULL DEFAULT 0`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/drizzle/drizzle-foundation.test.ts`:

```ts
import { paywalls } from "./schema";

it("paywalls carries a non-null draftRevision defaulting to 0", () => {
  const col = paywalls.draftRevision;
  expect(col).toBeDefined();
  expect(col.notNull).toBe(true);
  expect(col.hasDefault).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/db && DATABASE_URL="$DATABASE_URL" nice -n 19 npx vitest run src/drizzle/drizzle-foundation.test.ts --maxWorkers=2
```

Expected: FAIL — `paywalls.draftRevision` is undefined.

- [ ] **Step 3: Add the column**

In `packages/db/src/drizzle/schema.ts`, inside the `paywalls` table, directly after `publishedVersionId`:

```ts
    // Optimistic-concurrency token for `builderConfig`. Every draft
    // writer — the builder's autosave included — submits the revision it
    // read; a mismatch is a 409 and no write occurs. `updatedAt` was
    // rejected for this: unrelated updates touch it and timestamp
    // granularity is fragile. Bumped by `updatePaywallDraft` only.
    draftRevision: integer("draftRevision").notNull().default(0),
```

- [ ] **Step 4: Generate the migration**

```bash
pnpm db:migrate:generate
```

Open the generated SQL and confirm it is exactly an `ADD COLUMN` with a
default — Drizzle sometimes emits unrelated statements from hand-written
DDL drift. Delete anything that is not this column.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd packages/db && DATABASE_URL="$DATABASE_URL" nice -n 19 npx vitest run src/drizzle/drizzle-foundation.test.ts --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 6: Check the journal watermark — do NOT skip**

Every new migration in this repo has historically landed *below* the
journal watermark and been silently skipped on upgrade-path databases.
Drizzle's migrator applies rows by a `created_at` watermark, so a new
entry whose `when` is lower than the highest existing entry never runs.

```bash
python3 - <<'PY'
import json
j = json.load(open("packages/db/drizzle/migrations/meta/_journal.json"))
entries = j["entries"]
newest = max(e["when"] for e in entries)
last = entries[-1]
print("highest 'when' in journal:", newest)
print("this migration:", last["tag"], last["when"])
print("OK — above watermark" if last["when"] >= newest else "BROKEN — below watermark, will be skipped")
PY
```

Expected: `OK — above watermark`. If it prints BROKEN, raise the new
entry's `when` above the maximum before continuing.

- [ ] **Step 7: Replace the manual check with a guard test**

The watermark check in Step 6 is a ritual a future migration author will
forget — and forgetting it is invisible, because the migration still looks
applied locally and is skipped only on upgrade-path databases. Convert it
into a test.

Create `packages/db/src/drizzle/journal-monotonic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const JOURNAL_PATH = join(
  __dirname,
  "../../drizzle/migrations/meta/_journal.json",
);

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

describe("drizzle migration journal", () => {
  // Drizzle's migrator applies entries by a `created_at` watermark, so an
  // entry whose `when` is below an earlier entry's is never executed on a
  // database that already has history — it is silently skipped forever,
  // while looking perfectly applied on a fresh install. This repo has been
  // bitten by exactly that. Assert the invariant instead of remembering it.
  it("has strictly non-decreasing `when` values", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: JournalEntry[];
    };

    const regressions = journal.entries
      .map((entry, i) => ({ entry, prev: journal.entries[i - 1] }))
      .filter(({ entry, prev }) => prev !== undefined && entry.when < prev.when)
      .map(({ entry, prev }) => `${entry.tag} (${entry.when}) < ${prev!.tag} (${prev!.when})`);

    expect(regressions).toEqual([]);
  });
});
```

Run it:

```bash
cd packages/db && nice -n 19 npx vitest run src/drizzle/journal-monotonic.test.ts --maxWorkers=2
```

Expected: PASS. **If it fails on entries that predate this task, do not
"fix" the historical journal** — report it as DONE_WITH_CONCERNS with the
offending tags listed. Rewriting past `when` values would change which
migrations existing databases consider applied, which is a data-loss-shaped
risk, not a cleanup.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle packages/db/src/drizzle/journal-monotonic.test.ts
git commit -m "feat(db): add paywalls.draftRevision for optimistic concurrency"
```

---

### Task 4: Compare-and-swap draft writes, and 409 on the REST route

**Files:**
- Modify: `packages/db/src/drizzle/repositories/paywalls.ts`
- Modify: `apps/api/src/routes/dashboard/paywalls.ts`
- Modify: `apps/dashboard/src/lib/services/paywall-builder-api.ts` (autosave caller)
- Test: `apps/api/src/routes/dashboard/paywalls.concurrency.integration.test.ts` (create)

**Interfaces:**
- Consumes: `paywalls.draftRevision` (Task 3).
- Produces:
  ```ts
  updatePaywallDraft(
    db: Db,
    projectId: string,
    id: string,
    expectedRevision: number,
    patch: { builderConfig: unknown },
  ): Promise<Paywall | null>   // null === revision mismatch
  ```
  and `PATCH /paywalls/:id` accepting `draftRevision: number` in the body,
  answering **409** on mismatch.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/dashboard/paywalls.concurrency.integration.test.ts`.
Follow the harness in `offerings.integration.test.ts`: a bare Hono app with
`errorHandler`, the route mounted on its production path, real Postgres,
a real Better Auth session cookie.

```ts
const CONFLICT_STATUS = 409;

it("two concurrent draft writes: exactly one wins, the loser gets 409", async () => {
  const { cookie, projectId, paywallId } = await seedPaywall();

  const read = await app.request(
    `/projects/${projectId}/paywalls/${paywallId}`,
    { headers: { cookie } },
  );
  // GET /:id answers `{ data: { paywall: <row> } }` — the whole row, so
  // draftRevision rides along without a serializer change.
  const { data } = await read.json();
  const revision: number = data.paywall.draftRevision;

  // Both writers read the SAME revision, as two builder tabs would.
  const [first, second] = await Promise.all([
    app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ draftRevision: revision, builderConfig: { root: { id: "a", type: "stack", children: [] } } }),
    }),
    app.request(`/projects/${projectId}/paywalls/${paywallId}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ draftRevision: revision, builderConfig: { root: { id: "b", type: "stack", children: [] } } }),
    }),
  ]);

  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([200, CONFLICT_STATUS]);
});

it("a write without draftRevision is rejected, not defaulted", async () => {
  // An un-migrated client must fail closed rather than clobber.
  const { cookie, projectId, paywallId } = await seedPaywall();
  const res = await app.request(
    `/projects/${projectId}/paywalls/${paywallId}`,
    {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ builderConfig: { root: { id: "c", type: "stack", children: [] } } }),
    },
  );
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker ps
cd apps/api && nice -n 19 npx vitest run src/routes/dashboard/paywalls.concurrency.integration.test.ts --maxWorkers=2
```

Expected: FAIL — both writes currently return 200.

- [ ] **Step 3: Add the compare-and-swap repository function**

In `packages/db/src/drizzle/repositories/paywalls.ts`, beside `updatePaywall`:

```ts
/**
 * Draft write with optimistic concurrency. Returns null when
 * `expectedRevision` does not match the stored value — the caller turns
 * that into a 409. The revision bump and the config write are one
 * statement, so two concurrent callers cannot both succeed.
 */
export async function updatePaywallDraft(
  db: Db,
  projectId: string,
  id: string,
  expectedRevision: number,
  patch: { builderConfig: unknown },
): Promise<Paywall | null> {
  const [row] = await db
    .update(paywalls)
    .set({
      builderConfig: patch.builderConfig,
      draftRevision: sql`${paywalls.draftRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paywalls.projectId, projectId),
        eq(paywalls.id, id),
        eq(paywalls.draftRevision, expectedRevision),
      ),
    )
    .returning();
  return row ?? null;
}
```

- [ ] **Step 4: Enforce it on the route**

In `apps/api/src/routes/dashboard/paywalls.ts`, add to `updateBodySchema`:

```ts
  // Required whenever builderConfig is present: an un-migrated client
  // must fail closed rather than silently clobber a concurrent edit.
  draftRevision: z.number().int().nonnegative().optional(),
```

and refine the schema so the pair is enforced:

```ts
  .refine(
    (b) => b.builderConfig === undefined || b.draftRevision !== undefined,
    { message: "draftRevision is required when builderConfig is present" },
  )
```

In the `PATCH /:id` handler, when `builderConfig` is present, route through
the new function and answer 409 on null:

```ts
    if (body.builderConfig !== undefined) {
      const updated = await drizzle.paywallRepo.updatePaywallDraft(
        drizzle.db,
        projectId,
        id,
        body.draftRevision as number,
        { builderConfig: body.builderConfig },
      );
      if (!updated) {
        throw new HTTPException(409, {
          message: "Paywall draft changed since it was read; reload and retry",
        });
      }
    }
```

- [ ] **Step 5: Send the revision from the builder's autosave**

In `apps/dashboard/src/lib/services/paywall-builder-api.ts`, include the revision
the builder last read in the autosave PATCH body, and on a 409 response
reload the paywall and surface the conflict rather than retrying blindly.

```bash
grep -rn "builderConfig" apps/dashboard/src/lib/services/paywall-builder-api.ts
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/dashboard/paywalls --maxWorkers=2
```

Expected: PASS, including the pre-existing paywall route tests.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/drizzle/repositories/paywalls.ts apps/api/src apps/dashboard/src
git commit -m "feat(paywalls): optimistic concurrency on draft writes with 409 on conflict"
```

---

### Task 5: Make `action_paywall_editTree` persist — and remove the double-apply

The handler stops being a dry run. **The dashboard's client-side
apply-then-PATCH for the same approved op must be removed in this task.**
If both run, the op lands twice — an `insert` adds two nodes.
`draftRevision` would turn the second write into a 409 rather than a
duplicate, but relying on a conflict error to prevent a double-apply is a
latent bug, not a design.

**Files:**
- Modify: `apps/api/src/services/copilot/intent-handlers.ts` (~line 527)
- Modify: `apps/dashboard/src/**` — the builder's intent-approval path
- Test: `apps/api/src/services/copilot/intent-handlers.paywall.integration.test.ts` (create)

**Interfaces:**
- Consumes: `updatePaywallDraft` (Task 4), `paywalls:write` gate (Task 2).
- Produces: the handler returns `{ paywallId, draftRevision }` — the new revision after the write, so a caller can chain edits.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/copilot/intent-handlers.paywall.integration.test.ts` against real Postgres:

```ts
it("executing a paywall edit intent persists the new draft", async () => {
  const { projectId, userId, paywallId } = await seedPaywallWithDraft();

  await executeIntent({
    ctx: { projectId, userId },
    intent: {
      id: "i1",
      toolName: "action_paywall_editTree",
      payload: { paywallId, op: INSERT_TEXT_NODE_OP },
    },
  });

  const after = await drizzle.paywallRepo.findPaywallById(
    drizzle.db,
    projectId,
    paywallId,
  );
  // The dry-run handler left the draft untouched; this must not.
  expect(after?.builderConfig).not.toEqual(EMPTY_DRAFT);
  expect(after?.draftRevision).toBe(1);
});

it("a failed paywall edit leaves no audit row", async () => {
  // audit() runs inside the handler's transaction, so a rejected write
  // must roll the audit row back with it. A mocked transaction cannot
  // demonstrate this — hence real Postgres.
  const { projectId, userId, paywallId } = await seedPaywallWithDraft();
  const before = await countAuditRows(projectId);

  await expect(
    executeIntent({
      ctx: { projectId, userId },
      intent: {
        id: "i2",
        toolName: "action_paywall_editTree",
        payload: { paywallId, op: OP_TARGETING_A_MISSING_NODE },
      },
    }),
  ).rejects.toThrow();

  expect(await countAuditRows(projectId)).toBe(before);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker ps
cd apps/api && nice -n 19 npx vitest run src/services/copilot/intent-handlers.paywall.integration.test.ts --maxWorkers=2
```

Expected: FAIL — `builderConfig` is unchanged and `draftRevision` is 0, because the handler is a dry run.

- [ ] **Step 3: Give the format version one home**

Task 4 widened `updatePaywallDraft` to require `configFormatVersion`. The
route derives it inside the route-local `prepareBuilderConfigPatch`, which
also parses and needs `offeringPackageIds` — so the handler cannot reuse
that function, and hardcoding `2` would put back the magic literal Task 4's
review had removed.

Name the two versions once, in `apps/api/src/services/paywall-ai/validate-config.ts`
(which the intent handler already imports from):

```ts
/**
 * `builderConfig` format versions. 1 is the legacy shape — no builder tree,
 * remote config only. 2 is a component tree. Named here rather than derived
 * at each write site so the route and the intent handler cannot drift.
 */
export const BUILDER_CONFIG_EMPTY_FORMAT_VERSION = 1;
export const BUILDER_CONFIG_TREE_FORMAT_VERSION = 2;
```

Then replace the two literals in `prepareBuilderConfigPatch`
(`apps/api/src/routes/dashboard/paywalls.ts`, the `configFormatVersion: 1`
and `configFormatVersion: 2` returns) with these constants, importing them
in the route.

- [ ] **Step 4: Rewrite the handler**

Replace the `action_paywall_editTree` handler body in
`apps/api/src/services/copilot/intent-handlers.ts`. Replace the
"DRY-RUN ONLY" comment block above it as well — it now documents the
opposite of what the code does.

```ts
  // ------------------------------------------------------------------
  // action.paywall.editTree
  // Applies the approved `PaywallTreeOp` to the paywall's draft and
  // PERSISTS it, in one transaction with its audit row. This is the sole
  // carrier of persistence for an approved op — the dashboard no longer
  // applies it client-side (see design spec, D1).
  //
  // Only the DRAFT is written. `/v1/placements` serves the published
  // snapshot from `paywall_versions`, so nothing here reaches live
  // traffic until someone publishes.
  // ------------------------------------------------------------------
  registerIntentHandler("action_paywall_editTree", async (ctx, payload) => {
    const { paywallId, op } = editTreePayloadSchema.parse(payload);

    return drizzle.db.transaction(async (tx) => {
      // Cross-project guard: paywallId arrives verbatim from a tool call.
      const paywall = await drizzle.paywallRepo.findPaywallById(
        tx,
        ctx.projectId,
        paywallId,
      );
      if (!paywall) {
        throw new Error(`Paywall ${paywallId} not found in project`);
      }

      const currentDraft = resolvePaywallDraftConfig(paywall);
      const nextDraft = assertSaveValid(applyTreeOp(currentDraft, op));

      const updated = await drizzle.paywallRepo.updatePaywallDraft(
        tx,
        ctx.projectId,
        paywallId,
        paywall.draftRevision,
        {
          builderConfig: nextDraft,
          // A tree op always yields a tree, never the legacy empty shape.
          configFormatVersion: BUILDER_CONFIG_TREE_FORMAT_VERSION,
        },
      );
      if (!updated) {
        throw new Error(
          `Paywall ${paywallId} draft changed during approval; re-run the edit`,
        );
      }

      await audit(
        {
          projectId: ctx.projectId,
          userId: ctx.userId,
          action: "update",
          resource: "paywall",
          resourceId: paywallId,
          before: { draftRevision: paywall.draftRevision },
          after: { draftRevision: updated.draftRevision, op },
        },
        tx as Parameters<typeof audit>[1],
      );

      return { paywallId, draftRevision: updated.draftRevision };
    });
  });
```

- [ ] **Step 5: Remove the dashboard's client-side apply**

Find where the builder applies an approved intent's op locally and then
saves it, and delete that path — the builder now refetches the paywall
after a successful execute.

```bash
grep -rn "applyTreeOp\|action_paywall_editTree" apps/dashboard/src
```

Expected after the edit: the dashboard no longer calls `applyTreeOp` for an
approved intent, and refetches instead.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/api && nice -n 19 npx vitest run src/services/copilot --maxWorkers=2
```

Expected: PASS. The existing `action-paywall.test.ts` dry-run assertions
will need updating in this step — that is expected, not a regression.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/copilot apps/dashboard/src
git commit -m "feat(copilot): persist approved paywall tree edits server-side"
```

---

### Task 6: Per-type funnel page field rules

Pure function in `@rovenue/shared`, no wiring yet. A reviewer can reject
the rules without touching the publish route.

**Files:**
- Create: `packages/shared/src/funnel/page-fields.ts`
- Create: `packages/shared/src/funnel/page-fields.test.ts`
- Modify: `packages/shared/src/funnel/index.ts`

**Interfaces:**
- Consumes: `Page`, `ValidatorIssue`, `ValidationResult` from `./pages-schema` and `./validator`.
- Produces:
  ```ts
  validatePageFields(pages: Page[]): ValidationResult
  ```
  reusing the existing `ValidationResult` shape so the publish route can
  merge its issues with `validateFunnelGraph`'s.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/funnel/page-fields.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validatePageFields } from "./page-fields";

describe("validatePageFields", () => {
  it("rejects a single_choice page with no options", () => {
    const result = validatePageFields([
      { id: "p1", type: "single_choice", title: "Pick one" },
    ] as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("rejects a single_choice page whose options array is empty", () => {
    const result = validatePageFields([
      { id: "p1", type: "single_choice", title: "Pick one", options: [] },
    ] as never);
    expect(result.ok).toBe(false);
  });

  it("accepts a well-formed single_choice page", () => {
    const result = validatePageFields([
      {
        id: "p1",
        type: "single_choice",
        title: "Pick one",
        options: [{ label: "A", value: "a" }],
      },
    ] as never);
    expect(result.ok).toBe(true);
  });

  it("names the page and the field it is missing", () => {
    // An agent gets this text back as its only feedback, so it has to
    // say which page and which field.
    const result = validatePageFields([
      { id: "p9", type: "slider", title: "How much?" },
    ] as never);
    if (result.ok) throw new Error("expected failure");
    expect(result.issues[0]?.message).toContain("p9");
    expect(result.issues[0]?.message).toMatch(/min|max/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/shared && nice -n 19 npx vitest run src/funnel/page-fields.test.ts --maxWorkers=2
```

Expected: FAIL — module `./page-fields` does not exist.

- [ ] **Step 3: Implement the rules**

Create `packages/shared/src/funnel/page-fields.ts`:

```ts
import type { Page, PageType } from "./pages-schema";
import type { ValidationResult, ValidatorIssue } from "./validator";

/**
 * Per-type required fields. `pages-schema.ts` is deliberately permissive
 * — only `id` and `type` are required — because the dashboard UI enforced
 * these before save. Once a non-dashboard client can author funnels that
 * enforcement has to exist on the server too, so it lives here and runs
 * at PUBLISH time (see design spec, D4). Save stays permissive.
 *
 * A page type absent from this table has no required fields.
 */
const REQUIRED_FIELDS: Partial<Record<PageType, readonly string[]>> = {
  single_choice: ["options"],
  multi_choice: ["options"],
  picture_choice: ["options"],
  slider: ["min", "max"],
  opinion_scale: ["min", "max"],
  rating: ["max"],
  statement: ["body"],
  info: ["body"],
  legal: ["body"],
};

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

export function validatePageFields(pages: Page[]): ValidationResult {
  const issues: ValidatorIssue[] = [];

  for (const page of pages) {
    const required = REQUIRED_FIELDS[page.type];
    if (!required) continue;

    for (const field of required) {
      if (isEmpty((page as unknown as Record<string, unknown>)[field])) {
        issues.push({
          code: "MISSING_REQUIRED_FIELD",
          message: `Page "${page.id}" of type "${page.type}" is missing required field "${field}"`,
          pageId: page.id,
          field,
        });
      }
    }
  }

  return issues.length > 0
    ? { ok: false, issues, warnings: [] }
    : { ok: true, warnings: [] };
}
```

Add the issue variant to `packages/shared/src/funnel/validator.ts`'s `ValidatorIssue` union:

```ts
  | { code: "MISSING_REQUIRED_FIELD"; message: string; pageId: string; field: string }
```

Export from `packages/shared/src/funnel/index.ts`:

```ts
export { validatePageFields } from "./page-fields";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/shared && nice -n 19 npx vitest run src/funnel/page-fields.test.ts --maxWorkers=2
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/funnel
git commit -m "feat(shared): per-type funnel page field validation"
```

---

### Task 7: Measure the blast radius before enforcing (spec M1)

Runs **before** Task 8 wires the rules in. An already-published funnel that
fails the new rules gets blocked the next time its owner republishes. That
number is measured, never estimated.

**Files:**
- Create: `apps/api/src/scripts/measure-funnel-page-rules.ts`

**Interfaces:**
- Consumes: `validatePageFields` (Task 6).
- Produces: a printed report; its result is pasted into the design spec under M1.

- [ ] **Step 1: Write the script**

```ts
// Report-only. Reads every funnel's PUBLISHED pages and reports which
// would fail the new per-type rules. Writes nothing.
import { eq } from "drizzle-orm";
// `funnels` is named-exported from @rovenue/db but `funnelVersions` is
// NOT — reach both through the `drizzle.schema.*` namespace rather than
// widening the barrel for a one-off script.
import { drizzle, getDb } from "@rovenue/db";
import { pagesArraySchema, validatePageFields } from "@rovenue/shared/funnel";

const { funnels, funnelVersions } = drizzle.schema;

const EXIT_OK = 0;

async function main(): Promise<void> {
  const db = getDb();
  // Published pages do NOT live on `funnels`. `funnels.currentVersionId`
  // points at a `funnel_versions` row and the published pages are that
  // row's `pagesJson`. The draft (`funnels.draftPagesJson`) is not what
  // republishing will validate, so it is deliberately not read here.
  const rows = await db
    .select({
      funnelId: funnels.id,
      projectId: funnels.projectId,
      pagesJson: funnelVersions.pagesJson,
    })
    .from(funnels)
    .innerJoin(funnelVersions, eq(funnels.currentVersionId, funnelVersions.id));

  let failing = 0;
  const byCode = new Map<string, number>();

  for (const funnel of rows) {
    const parsed = pagesArraySchema.safeParse(funnel.pagesJson);
    if (!parsed.success) continue; // already unpublishable; not our rules
    const result = validatePageFields(parsed.data);
    if (result.ok) continue;

    failing += 1;
    for (const issue of result.issues) {
      byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);
    }
    console.log(`FAIL ${funnel.projectId}/${funnel.funnelId}: ${result.issues.map((i) => i.message).join("; ")}`);
  }

  console.log("---");
  console.log(`published funnels scanned: ${rows.length}`);
  console.log(`would now fail republish:  ${failing}`);
  for (const [code, n] of byCode) console.log(`  ${code}: ${n}`);
  process.exit(EXIT_OK);
}

void main();
```

This reads through Drizzle directly rather than adding a repo function:
the script is a one-off measurement, not product code, and the join it
needs exists nowhere else.

- [ ] **Step 2: Run it against the development database**

```bash
cd apps/api && npx tsx src/scripts/measure-funnel-page-rules.ts
```

- [ ] **Step 3: Record the result in the spec**

Paste the summary lines into
`docs/superpowers/specs/2026-09-07-paywall-funnel-authoring-paths-design.md`
under **M1**, replacing "Unknown until measured".

**Decision rule for Task 8:** if `would now fail republish` is 0, wire the
rules in as blocking. If it is non-zero, Task 8 ships them in report-only
mode — issues logged and returned as `warnings`, not `issues` — and
flipping to blocking becomes a separate follow-up once the listed funnels
are fixed.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/scripts/measure-funnel-page-rules.ts docs/superpowers/specs
git commit -m "chore(funnels): measure per-type rule impact on published funnels"
```

---

### Task 8: Wire the rules into publish, and funnel routes onto `funnels:write`

**Files:**
- Modify: `apps/api/src/routes/dashboard/funnels.ts`
- Test: `apps/api/src/routes/dashboard/funnels.publish-validation.integration.test.ts` (create)

**Interfaces:**
- Consumes: `validatePageFields` (Task 6), `funnels:write` (Task 1), the Task 7 decision rule.
- Produces: publish rejects per-type violations with the existing `FUNNEL_VALIDATION` error shape.

- [ ] **Step 1: Write the failing test**

```ts
const VALIDATION_STATUS = 400;

it("publish rejects a funnel whose choice page has no options", async () => {
  const { cookie, projectId, funnelId } = await seedFunnelWithPages([
    { id: "q1", type: "single_choice", title: "Pick", default_next: "pw" },
    { id: "pw", type: "paywall", default_next: "done" },
    { id: "done", type: "success" },
  ]);

  const res = await app.request(
    `/projects/${projectId}/funnels/${funnelId}/publish`,
    { method: "POST", headers: { cookie } },
  );

  expect(res.status).toBe(VALIDATION_STATUS);
  const body = JSON.parse((await res.json()).error.message);
  expect(body.code).toBe("FUNNEL_VALIDATION");
  expect(body.issues.some((i) => i.code === "MISSING_REQUIRED_FIELD")).toBe(true);
});

it("SAVING that same funnel still succeeds — save stays permissive", async () => {
  // Deliberate property, not an oversight: a work-in-progress draft
  // (human or agent) must never be blocked mid-edit. Without this test
  // someone will later "fix" save to validate too.
  const { cookie, projectId, funnelId } = await seedFunnel();
  const res = await app.request(
    `/projects/${projectId}/funnels/${funnelId}`,
    {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        draft_pages_json: [{ id: "q1", type: "single_choice", title: "Pick" }],
      }),
    },
  );
  expect(res.status).toBe(200);
});

it("GROWTH may publish a funnel; CUSTOMER_SUPPORT may not", async () => {
  // funnels:write is a faithful restatement of today's DEVELOPER rank
  // gate, which GROWTH already satisfies by rank equality.
  const growth = await seedPublishableFunnelWithRole("GROWTH");
  const cs = await seedPublishableFunnelWithRole("CUSTOMER_SUPPORT");

  expect(
    (await app.request(`/projects/${growth.projectId}/funnels/${growth.funnelId}/publish`, {
      method: "POST", headers: { cookie: growth.cookie },
    })).status,
  ).toBe(200);

  expect(
    (await app.request(`/projects/${cs.projectId}/funnels/${cs.funnelId}/publish`, {
      method: "POST", headers: { cookie: cs.cookie },
    })).status,
  ).toBe(403);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker ps
cd apps/api && nice -n 19 npx vitest run src/routes/dashboard/funnels.publish-validation.integration.test.ts --maxWorkers=2
```

Expected: FAIL — publish currently returns 200 for the optionless choice page.

- [ ] **Step 3: Run the rules at publish**

In `apps/api/src/routes/dashboard/funnels.ts`, directly after the existing
`validateFunnelGraph` block inside `POST /:funnelId/publish`:

```ts
    // Per-type page field rules. Deliberately here and not at save:
    // drafts stay permissive so a work-in-progress funnel — human or
    // agent-authored — is never blocked mid-edit (design spec, D4).
    const fields = validatePageFields(pages);
    if (!fields.ok) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "FUNNEL_VALIDATION",
          issues: fields.issues,
        }),
      });
    }
```

Import it:

```ts
import { validatePageFields } from "@rovenue/shared/funnel";
```

**If Task 7 measured a non-zero failure count**, do not throw here — push
`fields.issues` into the response as warnings and log them, and open a
follow-up to flip it to blocking.

- [ ] **Step 4: Move funnel mutations onto the capability gate**

Replace `assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER)`
with `assertProjectCapability(projectId, user.id, "funnels:write")` in
every funnel **mutation** handler: create, patch, delete, publish,
duplicate, revert, from-template. Leave the read handlers
(`assertProjectAccess(projectId, user.id)` with no role) alone.

```bash
grep -n "assertProjectAccess" apps/api/src/routes/dashboard/funnels.ts
```

Expected after the edit: only the no-role read calls remain.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/dashboard/funnels --maxWorkers=2
```

Expected: PASS, including the pre-existing funnel route tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/funnels.ts apps/api/src/routes/dashboard/funnels.publish-validation.integration.test.ts
git commit -m "feat(funnels): per-type publish validation and funnels:write gate"
```

---

### Task 9: The two guards that keep this true later

Both are structural. A per-route checklist would rot; these fail on a route
added next month.

**Files:**
- Create: `apps/api/src/routes/dashboard/authorization-surface.test.ts`
- Create: `apps/api/src/lib/placement-draft-isolation.integration.test.ts`

**Interfaces:**
- Consumes: the mounted `paywallsDashboardRoute` and `funnelsRoute` Hono instances.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the structural authorization guard**

Enumerate the routes from Hono's own `.routes` array (verified to expose
`{ method, path }`), then prove each mutating route is gated **by
behaviour**, not by grepping for a function name — a gate moved into a
helper or middleware would defeat a source scan while still being correct,
and a route that merely mentions the symbol in a comment would pass one.

CUSTOMER_SUPPORT holds neither `paywalls:write` nor `funnels:write`, so
every mutating route must reject it with 403. The capability gate runs
before body validation, so an empty body still yields 403 on a gated
route and 400/404/200 on an ungated one — which is exactly the failure
this guard exists to catch.

```ts
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const FORBIDDEN = 403;

// Routes that legitimately need no capability gate. Every entry needs a
// reason; an empty list is the healthy state.
const UNGATED_BY_DESIGN: ReadonlyArray<{ method: string; path: string; why: string }> = [];

function fillParams(path: string): string {
  // Hono paths carry `:param` segments; any non-empty value reaches the
  // gate, because authorization runs before the row is looked up.
  return path.replace(/:[A-Za-z0-9_]+/g, "does-not-exist");
}

it("every paywall/funnel mutation route rejects a role without the capability", async () => {
  const { cookie, projectId } = await seedProjectWithRole("CUSTOMER_SUPPORT");
  const offenders: string[] = [];

  for (const [label, route, mount] of [
    ["paywalls", paywallsDashboardRoute, `/projects/${projectId}/paywalls`],
    ["funnels", funnelsRoute, `/projects/${projectId}/funnels`],
  ] as const) {
    for (const r of route.routes) {
      if (!MUTATING_METHODS.has(r.method)) continue;
      if (UNGATED_BY_DESIGN.some((u) => u.method === r.method && u.path === r.path)) continue;

      const res = await app.request(`${mount}${fillParams(r.path)}`, {
        method: r.method,
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      });
      if (res.status !== FORBIDDEN) {
        offenders.push(`${label} ${r.method} ${r.path} → ${res.status}`);
      }
    }
  }

  expect(offenders).toEqual([]);
});
```

Mount both routers on one test app at the paths above. If a route
legitimately needs no gate, add it to `UNGATED_BY_DESIGN` with its reason —
never delete it from the sweep silently.

- [ ] **Step 2: Write the draft-isolation invariant test**

```ts
// The property the whole design rests on: authoring is safe because a
// draft write cannot reach live traffic. Pinned so a future change to
// placement resolution cannot quietly break it.
it("editing a draft does not change what /v1/placements serves", async () => {
  const { projectId, paywallId, placementIdentifier } = await seedPublishedPaywall();

  const before = await resolvePlacement(projectId, placementIdentifier);

  await drizzle.paywallRepo.updatePaywallDraft(
    drizzle.db,
    projectId,
    paywallId,
    0,
    { builderConfig: { root: { id: "changed", type: "stack", children: [] } } },
  );

  const after = await resolvePlacement(projectId, placementIdentifier);
  expect(after).toEqual(before);
});
```

- [ ] **Step 3: Run both tests to verify they pass**

```bash
docker ps
cd apps/api && nice -n 19 npx vitest run src/routes/dashboard/authorization-surface.test.ts src/lib/placement-draft-isolation.integration.test.ts --maxWorkers=2
```

Expected: PASS. If the authorization guard reports offenders, they are
real — fix the routes rather than the test.

- [ ] **Step 4: Run the full api suite once**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2
```

Expected: no new failures. Record the pass/fail counts; do not claim green
without pasting the summary line.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "test(api): structural capability guard and draft-isolation invariant"
```

---

## Self-review notes

**Spec coverage.** D1 → Task 5. D2 → Tasks 3, 4. D3 → Tasks 1, 2, 8 step 4.
D4 → Tasks 6, 8. M1 → Task 7. M2 → Task 4 step 4 (missing revision is a 400,
not a default). M3 → Task 3 step 6. Testing items 1–6 → Tasks 4, 8, 9, 5.

**Deviation from the spec, recorded deliberately.** The spec said every
paywall mutation path routes through `assertProjectCapability`. Task 2
implements that by adding an optional `requiresCapability` to the intent
row rather than re-gating `intents.ts` wholesale, because the execute route
is shared by every action tool and a blanket change would re-gate tools
outside this spec's scope. The end state matches the spec's intent; the
mechanism is narrower.

**Not covered here, by design.** The spec's open question about
`assertSaveValid` — whether its blocking set covers the three-platform
decoder contract, and its `offeringPackageIds: []` call — is **not** closed
by this plan. Task 5 makes `assertSaveValid` the correctness gate for
non-dashboard writers, which raises the stakes on that question without
answering it. It must be answered before sub-project C ships, and if either
gap is real, closing it is additional work in this sub-project.
