# Rovenue MCP Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rovenue customer connects their own MCP client to one of their projects with a revocable, user-bound token and asks questions about their subscription business — plus starts and stops experiments.

**Architecture:** A remote Streamable HTTP MCP server mounted at `/mcp` inside `apps/api`, running stateless (a fresh transport and server instance per request), authenticated by a new `mcp_tokens` table whose rows are bound to a user and a single project. Tools are served by tagging the existing copilot tool registry with the surfaces each tool belongs to, so chat and MCP share one definition. Writes go through the existing copilot intent flow.

**Tech Stack:** Hono, TypeScript strict, Drizzle ORM + Postgres 16, ClickHouse, Vitest (+ testcontainers), pnpm workspace, `@modelcontextprotocol/{core,server,hono}` v2.

**Spec:** `docs/superpowers/specs/2026-09-08-rovenue-mcp-foundation-design.md`

## Global Constraints

- **Stay on the current branch.** Do not create, switch, or delete branches or worktrees. The user manages branching.
- **Before every commit, run `git status --porcelain` and confirm no file you changed is left unstaged.**
- **No magic values.** Hoist literals into named constants. Structured data tables (a capability→roles map, a tool→surface map) are not magic values.
- **Throttle test runs:** `nice -n 19 npx vitest run <path> --maxWorkers=2` from the relevant package. Never run the full monorepo suite. Builds: `--concurrency=2`.
- **Take the v2 MCP packages, verified on the registry 2026-09-08:** `@modelcontextprotocol/core@2.0.0`, `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/hono@2.0.0`. **`@modelcontextprotocol/sdk` (1.30.0) is the v1 line — do not install it.** It implements the retired `initialize` / `Mcp-Session-Id` generation. `apps/api`'s `hono@^4.12.25` already satisfies the adapter's `^4.11.4` peer.
- **Discovery is `server/discover`.** The `initialize`/`initialized` exchange and `Mcp-Session-Id` were retired in the 2026-07-28 revision. Do not write code or tests against them.
- **Stateless: a new transport and server instance per request.** Sharing one instance causes request-id collisions between concurrent clients.
- **Response caps:** 50 rows per page, 200 maximum, 256 KB ceiling — whichever comes first. Truncation is stated in the response (`"47 of 1,203 rows"`), never silent.
- **`sterilizeToolResult` stays on** for every tool that returns subscriber data.
- **Errors:** a tool that ran and failed returns an MCP tool error the model can read and act on; protocol errors are reserved for authentication, authorization and malformed requests.
- **Postgres access via Drizzle only**; repositories under `packages/db/src/drizzle/repositories`.
- **Every new migration must be checked against the drizzle journal watermark** (`packages/db/drizzle/migrations/meta/_journal.json`). `packages/db/tests/journal-monotonic.test.ts` guards this — make sure it runs.
- **ClickHouse migrations run from inside the compose network**, never the host: the allow-list rejects Docker Desktop's host address and reports it to clients as "password is incorrect".

---

## A note on the SDK's API

**This plan does not contain verbatim `@modelcontextprotocol/*` call signatures.** They were not verified against an installed package, and inventing them is how a plan produces code that does not compile. Task 2 installs the packages, reads the published types, and records the real API — server construction, tool registration, the Hono adapter's mount, and the shape of a tool result — in its report. Later tasks consume that report rather than a guess written here.

Where this plan describes SDK-adjacent behaviour, it states the *requirement* ("the server declares only the primitives it implements"), not the call.

---

## Phases

**Phase 1 — Tasks 1-5.** A working, authenticated, zero-tool MCP endpoint. Independently shippable and testable: a client can connect, discover capabilities, and be correctly rejected. Stop here if you want a checkpoint.

**Phase 2 — Tasks 6-11.** The tool surface, resources, writes, quota, the access trail, and the guards.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `docs/superpowers/specs/2026-09-08-rovenue-mcp-foundation-design.md` | R1's answer recorded under the risk | 1 |
| `apps/api/package.json` | the three v2 MCP dependencies | 2 |
| `apps/api/src/services/mcp/server.ts` | builds a per-request MCP server; declares capabilities and `instructions` | 2 |
| `apps/api/src/routes/mcp/index.ts` | Hono route: the adapter mount, `Origin` validation | 2 |
| `apps/api/src/app.ts` | mounts `/mcp` | 2 |
| `packages/db/src/drizzle/schema.ts` | `mcpTokens` table; `aggregate_type` gains `MCP_ACCESS` | 3, 10 |
| `packages/db/src/drizzle/repositories/mcp-tokens.ts` | create / find-by-id / touch / revoke | 3 |
| `apps/api/src/routes/mcp/auth.ts` | `TokenVerifier` seam: prefix parse, indexed lookup, hash compare, revoked/expired, scope | 4 |
| `apps/api/src/routes/dashboard/mcp-tokens.ts` | dashboard CRUD, one-time secret display | 4 |
| `apps/api/src/services/mcp/authorize.ts` | per-request `assertProjectAccess` + capability alignment | 5 |
| `apps/api/src/services/copilot/tools/*.ts` | each tool declares its `surfaces` | 6 |
| `apps/api/src/services/mcp/tools.ts` | registry → MCP tool adapter, consolidation, caps, truncation | 6 |
| `apps/api/src/services/copilot/tools/query-funnels.ts` | `find_funnels` — funnels have no read tool today | 7 |
| `apps/api/src/services/mcp/resources.ts` | the three resources that ship | 8 |
| `apps/api/src/services/mcp/write-tools.ts` | `start_experiment` / `stop_experiment` via intent + elicitation | 9 |
| `apps/api/src/services/mcp/access-log.ts` | one `outbox_events` row per tool call | 10 |
| `packages/db/clickhouse/migrations/0025_mcp_access_log.sql` | the ClickHouse side | 10 |
| `apps/api/src/services/mcp/mcp-surface.test.ts` | capability/primitive guard | 11 |
| `apps/api/src/services/mcp/evals/` | tool-selection eval set | 11 |

---

# Phase 1 — Foundation

### Task 1: Answer R1 — does sandbox revenue reach ClickHouse?

`get_metrics` is blocked on this and it is an investigation, not a build. `purchases` carries an `environment` column; the ClickHouse schema has **no environment dimension at all** and `listDailyMrr` does not filter on one. So either sandbox purchases never reach ClickHouse, or they are silently mixed into production revenue.

Today a person reads those numbers inside a dashboard. This plan hands them to an agent that will state them as fact.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-08-rovenue-mcp-foundation-design.md` (record the answer under R1)

**Interfaces:**
- Consumes: nothing.
- Produces: a written answer that decides whether `get_metrics` ships in Task 6, ships with an environment filter, or leaves A.

- [ ] **Step 1: Trace the producer**

Find where a purchase becomes a `REVENUE_EVENT` outbox row and read whether anything filters on `purchases.environment`.

```bash
grep -rn "REVENUE_EVENT" apps/api/src --include=*.ts | grep -v "\.test\."
```

- [ ] **Step 2: Trace the consumer**

Read the ClickHouse revenue tables and their Kafka-fed materialized views for any environment column.

```bash
grep -rln "environment" packages/db/clickhouse/migrations/
```

Expected today: no matches. Confirm rather than assume.

- [ ] **Step 3: Check the live data**

```bash
docker exec rovenue-db-1 psql -U rovenue -d rovenue -tAc \
  "select environment, count(*) from purchases group by environment;"
```

If SANDBOX rows exist and reach the outbox unfiltered, production metrics are contaminated today.

- [ ] **Step 4: Record the answer and its consequence**

Write the finding under **R1** in the spec, replacing the open question. State which of the three outcomes applies:

- *Sandbox never reaches ClickHouse* — `get_metrics` ships as designed; record the mechanism that guarantees it so a future change cannot break it silently.
- *Sandbox is mixed in* — this is a pre-existing correctness bug in the dashboard's own numbers, not just MCP's. `get_metrics` does not ship until it is fixed; open a separate item and note that the dashboard is affected too.
- *No sandbox data exists anywhere* — the question is unanswerable from this environment. Say so; do not record "clean" for "empty". A 0-of-0 result is not evidence, the same way it was not for the funnel measurement.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs
git commit -m "docs(spec): record R1 — whether sandbox revenue reaches ClickHouse"
```

---

### Task 2: Install the v2 SDK and answer discovery at `/mcp`

The first task that touches the SDK, so it also owns **reading and recording the SDK's real API** for every later task.

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/services/mcp/server.ts`
- Create: `apps/api/src/routes/mcp/index.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/mcp/discovery.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildMcpServer(ctx)` returning a fresh server instance per request; `mcpRoute` (a Hono app) mounted at `/mcp`. **And, in the task report: the SDK's actual API** — how a server is constructed, how a tool is registered, how the Hono adapter mounts, and the shape of a tool result. Later tasks read that report rather than guessing.

- [ ] **Step 1: Install and read**

```bash
cd apps/api && pnpm add @modelcontextprotocol/core@2.0.0 @modelcontextprotocol/server@2.0.0 @modelcontextprotocol/hono@2.0.0
```

Then read the installed type declarations — `node_modules/@modelcontextprotocol/server/dist/index.d.mts` and the Hono adapter's — and write into your report: the server constructor's options, the tool-registration call, the Hono mount, and the tool-result shape. Quote the real signatures.

If any of the three packages fails to install or its types contradict this plan, **stop and report NEEDS_CONTEXT** rather than improvising around it.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/mcp/discovery.test.ts`. Two behaviours, both independent of the SDK's internals:

```ts
const FORBIDDEN = 403;
const DISALLOWED_ORIGIN = "https://evil.example";

it("rejects a request carrying a disallowed Origin", async () => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { origin: DISALLOWED_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
  });
  expect(res.status).toBe(FORBIDDEN);
});

it("declares only the primitives it implements", async () => {
  // Prompts are deliberately out of scope (design spec, D4a). The server
  // must not advertise a primitive it does not serve — a client that sees
  // `prompts` will call `prompts/list` and get a protocol error.
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
  });
  const body = await res.json();
  const declared = Object.keys(body.result.capabilities ?? {});
  expect(declared).toContain("tools");
  expect(declared).toContain("resources");
  expect(declared).not.toContain("prompts");
});
```

Adjust the response-path expressions once Step 1 tells you the real discovery result shape — but do not weaken what is asserted.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/mcp/discovery.test.ts --maxWorkers=2
```

Expected: FAIL — `/mcp` does not exist.

- [ ] **Step 4: Build the per-request server**

`apps/api/src/services/mcp/server.ts` exports a factory, not a singleton:

```ts
/**
 * A FRESH server per request. The SDK documents that sharing one instance
 * across concurrent clients collides their request ids, and the 2026-07-28
 * revision moved the protocol to a stateless core precisely so this is the
 * normal shape. It also matters operationally: apps/api may run several
 * replicas, and a session held in one process's memory breaks behind a
 * load balancer.
 */
export function buildMcpServer(ctx: McpRequestContext) { /* … */ }
```

Declare `name`, `version`, and an `instructions` string. `instructions` is interface, not boilerplate — tell the client's model that a token is scoped to exactly one project, that subscriber PII is stripped from results, and that write tools require a confirmation step.

Declare **only** `tools` and `resources`. Not `prompts`.

- [ ] **Step 5: Mount it with Origin validation**

`apps/api/src/routes/mcp/index.ts` validates `Origin` before anything else — HTTP transports are exposed to DNS rebinding, and this is not optional — then delegates to the Hono adapter.

In `apps/api/src/app.ts`, add `.route("/mcp", mcpRoute)` **after** `.route("/dashboard", dashboardRoute)`.

Hono matches by registration order, not path specificity. `/mcp` carries its own prefix so it avoids the trap that forces `paywallPreviewRoute` to be registered before `/v1` — but keep the route's own middleware scoped inside the mounted subtree with `.use("*", …)` on `mcpRoute`, never on the root app.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/mcp --maxWorkers=2
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/src pnpm-lock.yaml
git commit -m "feat(mcp): serve discovery at /mcp with Origin validation"
```

---

### Task 3: The `mcp_tokens` table

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/drizzle/migrations/<next>_mcp_tokens.sql`
- Create: `packages/db/src/drizzle/repositories/mcp-tokens.ts`
- Modify: `packages/db/src/drizzle/index.ts` (barrel)
- Test: `packages/db/src/drizzle/drizzle-foundation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  mcpTokens        // table
  mcpTokenRepo.create(db, row): Promise<McpToken>
  mcpTokenRepo.findById(db, id): Promise<McpToken | null>
  mcpTokenRepo.touchLastUsed(db, id): Promise<void>
  mcpTokenRepo.revoke(db, projectId, id): Promise<McpToken | null>
  mcpTokenRepo.listByProject(db, projectId): Promise<McpToken[]>
  ```

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/drizzle/drizzle-foundation.test.ts`:

```ts
import { mcpTokens } from "./schema";

const EXPECTED_SCOPES = ["read", "read_write"] as const;

it("mcp_tokens binds a token to a user and one project", () => {
  expect(mcpTokens.userId.notNull).toBe(true);
  expect(mcpTokens.projectId.notNull).toBe(true);
  expect(mcpTokens.scope.notNull).toBe(true);
});

it("mcp_tokens can be revoked and expired independently", () => {
  // Both nullable: null means "not revoked" / "never expires".
  expect(mcpTokens.revokedAt.notNull).toBe(false);
  expect(mcpTokens.expiresAt.notNull).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/db && DATABASE_URL="$DATABASE_URL" nice -n 19 npx vitest run src/drizzle/drizzle-foundation.test.ts --maxWorkers=2
```

- [ ] **Step 3: Add the table**

Model it on `apiKeys` (`packages/db/src/drizzle/schema.ts`), which is the closest sibling — but do **not** carry over its `environment` or `allowedOrigins` columns; neither means anything here.

```ts
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The reason this table exists rather than a third kind in `api_keys`:
    // a token is bound to a PERSON, so the audit actor is a real user id
    // and not "an API key". Cascade on user deletion — a token outliving
    // its owner would be an orphan with live access.
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    // Least privilege applies to the TOKEN, not only to the human: an
    // OWNER must be able to mint a read-only token.
    scope: text("scope").notNull(),
    keyPublic: text("keyPublic").notNull().unique(),
    keySecretHash: text("keySecretHash").notNull(),
    lastUsedAt: timestamp("lastUsedAt", { withTimezone: true }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdIdx: index("mcp_tokens_projectId_idx").on(t.projectId),
    userIdIdx: index("mcp_tokens_userId_idx").on(t.userId),
  }),
);
```

The Better Auth users table is exported as `user` (`packages/db/src/drizzle/schema.ts:108`) — verified, not assumed.

- [ ] **Step 4: Generate the migration and check the watermark**

```bash
pnpm db:migrate:generate
cd packages/db && DATABASE_URL="$DATABASE_URL" nice -n 19 npx vitest run tests/journal-monotonic.test.ts --maxWorkers=2
```

Open the generated SQL and confirm it is only this table. Drizzle sometimes emits unrelated statements from hand-written DDL drift; delete anything that is not `mcp_tokens`.

- [ ] **Step 5: Write the repository**

Follow the shape of `packages/db/src/drizzle/repositories/paywalls.ts`. `revoke` is scoped by `projectId` as well as `id` — an IDOR guard, the same precedent every repository here follows.

- [ ] **Step 6: Run the tests and commit**

```bash
cd packages/db && DATABASE_URL="$DATABASE_URL" nice -n 19 npx vitest run src/drizzle --maxWorkers=2
git add packages/db/src packages/db/drizzle
git commit -m "feat(db): add mcp_tokens, bound to a user and one project"
```

---

### Task 4: Token verification and dashboard management

**Files:**
- Create: `apps/api/src/routes/mcp/auth.ts`
- Create: `apps/api/src/routes/dashboard/mcp-tokens.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts`
- Modify: `packages/shared/src/index.ts` (the new prefix)
- Test: `apps/api/src/routes/mcp/auth.integration.test.ts`

**Interfaces:**
- Consumes: `mcpTokenRepo` (Task 3).
- Produces: `verifyMcpToken(rawToken): Promise<McpTokenContext | null>` where `McpTokenContext = { tokenId, projectId, userId, scope }`; `mcpTokensRoute` mounted under `/dashboard/projects/:projectId/mcp-tokens`.

- [ ] **Step 1: Write the failing test**

Real Postgres, following `apps/api/src/routes/dashboard/offerings.integration.test.ts`'s harness.

```ts
const UNAUTHORIZED = 401;

it("accepts a live token and rejects a revoked one", async () => {
  const { raw, tokenId } = await seedMcpToken({ scope: "read" });
  expect((await callMcp(raw)).status).not.toBe(UNAUTHORIZED);

  await drizzle.mcpTokenRepo.revoke(drizzle.db, projectId, tokenId);
  // Revocation takes effect on the NEXT request with no session to expire,
  // because the server is stateless. Assert that, don't assume it.
  expect((await callMcp(raw)).status).toBe(UNAUTHORIZED);
});

it("rejects an expired token", async () => {
  const { raw } = await seedMcpToken({ scope: "read", expiresAt: new Date(Date.now() - 1000) });
  expect((await callMcp(raw)).status).toBe(UNAUTHORIZED);
});

it("apiKeyAuth cannot classify an MCP token, and fails closed", async () => {
  // This is the whole justification for a separate table rather than a
  // third kind in `api_keys`: an MCP token must not become accepted by
  // every /v1/* route that uses apiKeyAuth("any"). Assert it.
  const { raw } = await seedMcpToken({ scope: "read_write" });
  const res = await app.request("/v1/offerings", { headers: { authorization: `Bearer ${raw}` } });
  expect(res.status).toBe(UNAUTHORIZED);
});

it("shows the secret exactly once", async () => {
  const created = await createTokenViaDashboard();
  expect(created.body.data.token).toMatch(/^rov_mcp_/);
  const listed = await listTokensViaDashboard();
  expect(JSON.stringify(listed.body)).not.toContain(created.body.data.token);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
docker ps
cd apps/api && nice -n 19 npx vitest run src/routes/mcp/auth.integration.test.ts --maxWorkers=2
```

- [ ] **Step 3: Add the prefix**

In `packages/shared/src/index.ts`, beside `API_KEY_PREFIX`, add a **separate** constant — do not extend `API_KEY_KIND`:

```ts
/**
 * MCP tokens are deliberately NOT a third `API_KEY_KIND`. `apiKeyAuth("any")`
 * classifies by prefix and accepts PUBLIC or SECRET; adding a kind there
 * would make every /v1/* route using "any" start accepting MCP tokens
 * unless every call site were audited. A distinct prefix on a distinct
 * table means `apiKeyAuth` cannot classify it and fails closed.
 */
export const MCP_TOKEN_PREFIX = "rov_mcp_";
```

- [ ] **Step 4: Implement verification**

Follow `apps/api/src/middleware/api-key-auth.ts`'s layout exactly, because its reasoning applies unchanged: the token is `rov_mcp_<tokenId>_<random>` so the row can be found by an **indexed lookup on the embedded id** before running one `bcrypt.compare` — otherwise every request would bcrypt every non-revoked token in the table. Compare the **whole raw token** against `keySecretHash`, as `api-key-auth.ts:113` does.

Reject, in this order: unparseable prefix → row not found → `revokedAt` set → `expiresAt` in the past. All four are the same 401 to the caller; do not leak which.

Structure it as a `TokenVerifier`-shaped function so OAuth can later slot into the same seam. **Do not publish `/.well-known/oauth-protected-resource`** — advertising an authorization server that does not exist makes a conformant client attempt a flow that cannot succeed.

**Never accept a token Rovenue did not issue.** There is no passthrough path here and there must not be one.

- [ ] **Step 5: Dashboard CRUD**

`POST` (create, returns the secret **once**), `GET` (list, never returns the secret or its hash), `DELETE` (revoke). Gate all three on `assertProjectCapability(projectId, user.id, "project:settings:write")` — minting a credential that reads project data is a settings-tier action, not an everyday one.

Audit every create and revoke via `audit()` inside the same transaction. `AuditResource` in `apps/api/src/lib/audit.ts` has **no `mcp_token` value** — verified — so add it rather than overloading `api_key`, which would make the two credential kinds indistinguishable in the chain.

- [ ] **Step 6: Run the tests and commit**

```bash
cd apps/api && nice -n 19 npx vitest run src/routes/mcp src/routes/dashboard/mcp-tokens --maxWorkers=2
git add apps/api/src packages/shared/src
git commit -m "feat(mcp): token verification and dashboard token management"
```

---

### Task 5: Per-request authorization and scope

**Files:**
- Create: `apps/api/src/services/mcp/authorize.ts`
- Modify: `apps/api/src/routes/mcp/index.ts`
- Test: `apps/api/src/services/mcp/authorize.integration.test.ts`

**Interfaces:**
- Consumes: `McpTokenContext` (Task 4), `assertProjectAccess`, `assertProjectCapability`.
- Produces: `authorizeMcpRequest(ctx): Promise<{ role: MemberRole }>` — throws on a dead membership; and `assertToolAllowed(ctx, tool)` — throws when a `read` token reaches a write tool.

- [ ] **Step 1: Write the failing test**

```ts
it("a token dies with its owner's membership", async () => {
  // The token carries NO baked-in role. If it did, a demoted user would
  // keep their old privileges until the token expired.
  const { raw, userId } = await seedMcpToken({ scope: "read", role: "ADMIN" });
  expect((await callMcp(raw)).status).not.toBe(FORBIDDEN);

  await removeMembership(projectId, userId);
  expect((await callMcp(raw)).status).toBe(FORBIDDEN);
});

it("a read token cannot reach a write tool even when its owner could", async () => {
  // Least privilege belongs to the token. The refusal must happen BEFORE
  // an intent row is created — a rejected call must leave no trace of a
  // proposed mutation.
  const { raw, projectId } = await seedMcpToken({ scope: "read", role: "OWNER" });
  const before = await countIntents(projectId);

  const res = await callTool(raw, "stop_experiment", { experimentId: "exp_1" });

  expect(res.status).toBe(FORBIDDEN);
  expect(await countIntents(projectId)).toBe(before);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
docker ps
cd apps/api && nice -n 19 npx vitest run src/services/mcp/authorize.integration.test.ts --maxWorkers=2
```

- [ ] **Step 3: Implement**

`authorizeMcpRequest` calls `assertProjectAccess(ctx.projectId, ctx.userId)` on **every request**. No caching of the role across requests — a demotion must take effect immediately, and the server is stateless anyway.

`assertToolAllowed` checks the token's `scope` against a `TOOL_SURFACE` map that marks each tool read or write. It runs **before** the tool body, so a scope rejection never creates an intent row.

Write tools additionally go through the capability the dashboard uses — `assertProjectCapability` with the same capability the corresponding intent declares. Do not invent a parallel policy: the entire point of the preceding sub-project was to stop one mutation answering to two different gates.

Read tools have **no** existing role gate to inherit — the copilot's `query_*` tools carry none. Do not silently copy that gap. The rule: a role sees through MCP exactly what it sees in the dashboard. Where the dashboard has no read differentiation, inherit that and record it in the spec as a dashboard-side question; do not patch it here.

- [ ] **Step 4: Run the tests and commit**

```bash
cd apps/api && nice -n 19 npx vitest run src/services/mcp --maxWorkers=2
git add apps/api/src
git commit -m "feat(mcp): resolve authorization per request and enforce token scope"
```

**End of Phase 1.** At this point a client can connect to `/mcp`, be authenticated by a revocable user-bound token, be authorized against live membership, and be correctly refused — with no tools served yet. This is a coherent, testable, mergeable checkpoint.

---

# Phase 2 — The surface

### Task 6: Serve the read tools from one surface-tagged registry

The copilot's registry is chat-shaped, not agent-shaped. Mirroring its seventeen tools would be the anti-pattern the design rejects: with dozens of tools, JSON schemas can eat 40–50% of the model's context while *reducing* accuracy. Consolidate instead — and do it by tagging **one** definition with the surfaces it serves, not by writing a second registry that drifts from the first.

**Files:**
- Modify: `apps/api/src/services/copilot/tools/index.ts` (a `surface` parameter)
- Modify: each `apps/api/src/services/copilot/tools/query-*.ts` and `ui.ts` (declare surfaces)
- Create: `apps/api/src/services/mcp/tools.ts` (the adapter, consolidation, caps)
- Test: `apps/api/src/services/mcp/tools.integration.test.ts`

**Interfaces:**
- Consumes: `loadTools(ctx)`, the SDK's tool-registration API as recorded in Task 2's report.
- Produces: `registerMcpTools(server, ctx)`.

Tools served (eight; `get_metrics` only if Task 1 cleared it):

| MCP tool | Consolidates |
|---|---|
| `get_metrics` | `query_metrics_mrr` + `_churn` + `_conversion` — all three already share one `DateRangeArgs`, so a `metric` enum is the natural shape |
| `find_subscribers` | `query_subscribers_search` + `_get` |
| `list_subscriptions` | `query_subscriptions_list` |
| `list_catalog` | `query_products_list` + `query_productGroups_list` — both in one call beats two round trips |
| `list_audiences` | `query_audiences_list` |
| `list_feature_flags` | `query_featureFlags_list` |
| `list_experiments` | `query_experiments_list` |
| `get_paywall` | `query_paywall_tree`, with its builder-route gate removed |

- [ ] **Step 1: Write the failing test**

```ts
const MAX_PAGE = 200;

it("serves the consolidated surface, and no ui_* tool", async () => {
  const names = await listMcpToolNames(readToken);
  expect(names).toContain("get_metrics");
  expect(names.filter((n) => n.startsWith("ui_"))).toEqual([]);
  // The three metric tools became one.
  expect(names).not.toContain("query_metrics_mrr");
});

it("serves the paywall tool, which chat gates behind a builder route", async () => {
  // ctx.route gates it for chat; MCP has no route, so a naive port would
  // serve it never. Assert it is present.
  expect(await listMcpToolNames(readToken)).toContain("get_paywall");
});

it("caps a page and says so rather than truncating silently", async () => {
  await seedSubscribers(MAX_PAGE + 50);
  const res = await callTool(readToken, "find_subscribers", { limit: 1000 });
  expect(res.rows.length).toBeLessThanOrEqual(MAX_PAGE);
  expect(res.truncationNote).toMatch(/of \d+/);
});

it("strips subscriber PII", async () => {
  const res = await callTool(readToken, "find_subscribers", {});
  expect(JSON.stringify(res)).not.toContain("@");
});

it("a missing id is a tool error the model can act on, not a protocol error", async () => {
  const res = await callTool(readToken, "get_paywall", { paywallId: "nope" });
  expect(res.isError).toBe(true);
  expect(res.text).toMatch(/list|not found/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
docker ps
cd apps/api && nice -n 19 npx vitest run src/services/mcp/tools.integration.test.ts --maxWorkers=2
```

- [ ] **Step 3: Tag the registry**

Give `loadTools` a `surface: "chat" | "mcp"` parameter. Each tool declares which surfaces it belongs to:

- `ui_navigate`, `ui_filter`, `ui_openSubscriber` → `chat` only.
- `query_paywall_tree` → `chat` (still route-gated there) **and** `mcp` (always available). The route gate applies only to the chat surface; MCP has no route, so a straight port would serve it never.
- Everything else read → both.

The chat path through `streamText` must not change. Assert that by running the existing copilot suite unchanged.

- [ ] **Step 4: Write the adapter**

`apps/api/src/services/mcp/tools.ts` converts each tool's zod `inputSchema` to the JSON Schema the SDK expects (use the registration API from Task 2's report), applies the consolidation table above, and enforces the caps: 50 rows per page, 200 maximum, 256 KB — whichever comes first.

Truncation is **stated** in the result. Errors carry the next action ("`experimentId` not found; call `list_experiments` for valid ids"), and a tool that ran and failed returns a tool error, not a protocol error.

`sterilizeToolResult` stays on.

- [ ] **Step 5: Run both suites and commit**

```bash
cd apps/api && nice -n 19 npx vitest run src/services/mcp src/services/copilot --maxWorkers=2
git add apps/api/src
git commit -m "feat(mcp): serve consolidated read tools from the shared registry"
```

---

### Task 7: `find_funnels`

Funnels have no copilot read tool at all, so this one is new rather than adapted.

**Files:**
- Create: `apps/api/src/services/copilot/tools/query-funnels.ts`
- Modify: `apps/api/src/services/copilot/tools/index.ts`
- Test: `apps/api/src/services/copilot/tools/query-funnels.test.ts`

**Interfaces:**
- Consumes: `funnelRepo.listByProject`, `funnelRepo.findById`.
- Produces: `queryFunnelsTools(ctx)` exposing `find_funnels`, tagged for both surfaces.

- [ ] **Step 1: Write the failing test**

```ts
it("lists funnels in the project and never leaks another project's", async () => {
  const { projectId } = await seedFunnels(3);
  const other = await seedFunnelInAnotherProject();
  const res = await runTool("find_funnels", {});
  expect(res.funnels).toHaveLength(3);
  expect(res.funnels.map((f) => f.id)).not.toContain(other.id);
});

it("returns detail for one funnel when given an id", async () => {
  const { projectId, funnelId } = await seedFunnels(1);
  const res = await runTool("find_funnels", { id: funnelId });
  expect(res.funnel.id).toBe(funnelId);
  expect(res.funnel.pageCount).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Run it to verify it fails**, then implement, then re-run.

The tool takes an optional `id`: given one it returns detail, otherwise a filtered list. Return the published page count and the slug — an agent needs something to act on, not the whole `pagesJson`, which would blow the response cap on a large funnel.

Re-scope every read by `ctx.projectId`. The id arrives verbatim from a tool call; this is the same IDOR precedent every handler in that directory follows.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/copilot/tools
git commit -m "feat(tools): add find_funnels for both chat and MCP"
```

---

### Task 8: Resources

**Files:**
- Create: `apps/api/src/services/mcp/resources.ts`
- Test: `apps/api/src/services/mcp/resources.integration.test.ts`

**Interfaces:**
- Consumes: the tools from Tasks 6-7; the SDK's resource API from Task 2's report.
- Produces: `registerMcpResources(server, ctx)`.

Three resources ship: `rovenue://paywall/{id}`, `rovenue://catalog/products`, `rovenue://experiments`. The fourth, `rovenue://schema/clickhouse`, ships with `run_analytics_query` or not at all — its only mirror is that tool's schema mode.

- [ ] **Step 1: Write the failing test**

```ts
it("every resource is mirrored by a tool", async () => {
  // Client support for resources is uneven, so nothing load-bearing may
  // live only in a resource. This guard is the reason that stays true.
  const MIRRORS: Record<string, string> = {
    "rovenue://catalog/products": "list_catalog",
    "rovenue://experiments": "list_experiments",
    "rovenue://paywall/{id}": "get_paywall",
  };
  const resources = await listMcpResources(readToken);
  const tools = await listMcpToolNames(readToken);
  for (const uri of resources) {
    expect(tools).toContain(MIRRORS[uri]);
  }
});

it("a resource is scoped to the token's project", async () => {
  const other = await seedPaywallInAnotherProject();
  await expect(readResource(readToken, `rovenue://paywall/${other.id}`)).rejects.toThrow();
});
```

- [ ] **Step 2: Run it to verify it fails**, implement, re-run, commit.

```bash
git add apps/api/src/services/mcp
git commit -m "feat(mcp): serve paywall, catalog and experiment resources"
```

---

### Task 9: The two write tools

`start_experiment` and `stop_experiment` are the only writes in A, chosen because they are the only `action_*` tools whose intent handlers already execute server-side (`action.experiments.start` / `.stop` → `experimentRepo.updateExperiment`). They stay **separate tools** so their annotations can differ, rather than collapsing into one `manage_experiment(action)` — a tool-level annotation cannot vary per action, so a combined tool could not describe itself honestly.

**Files:**
- Create: `apps/api/src/services/mcp/write-tools.ts`
- Test: `apps/api/src/services/mcp/write-tools.integration.test.ts`

**Interfaces:**
- Consumes: `createIntentTool`'s intent creation, `executeIntent`, `assertToolAllowed` (Task 5); the SDK's elicitation API from Task 2's report.
- Produces: `registerMcpWriteTools(server, ctx)`.

- [ ] **Step 1: Write the failing test**

```ts
it("proposes rather than mutating, and mutates only after confirmation", async () => {
  const before = await getExperimentStatus(experimentId);
  const proposal = await callTool(writeToken, "stop_experiment", { experimentId });

  // The first call must NOT have changed anything.
  expect(await getExperimentStatus(experimentId)).toBe(before);
  expect(proposal.requiresConfirmation).toBe(true);

  const confirmed = await confirmElicitation(writeToken, proposal);
  expect(confirmed.isError).toBeFalsy();
  expect(await getExperimentStatus(experimentId)).toBe("COMPLETED");
});

it("writes an audit row naming the token's owner, not an API key", async () => {
  // This is why mcp_tokens carries userId at all.
  const { userId } = await seedMcpToken({ scope: "read_write", role: "ADMIN" });
  const proposal = await callTool(writeToken, "start_experiment", { experimentId });
  await confirmElicitation(writeToken, proposal);

  const row = await latestAuditRow(projectId);
  expect(row.userId).toBe(userId);
  expect(row.resource).toBe("experiment");
});

it("declines cleanly when the user refuses", async () => {
  const proposal = await callTool(writeToken, "stop_experiment", { experimentId });
  const declined = await declineElicitation(writeToken, proposal);
  expect(declined.isError).toBe(true);
  expect(await getExperimentStatus(experimentId)).not.toBe("COMPLETED");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
docker ps
cd apps/api && nice -n 19 npx vitest run src/services/mcp/write-tools.integration.test.ts --maxWorkers=2
```

- [ ] **Step 3: Implement**

Each tool creates a copilot intent — preview, `requiresCapability`, expiry, status machine — exactly as the dashboard does. It does **not** mutate.

Confirmation uses **elicitation**: the handler returns an input-required result and the client re-issues the original call with the response and the echoed request state. There is no persistent bidirectional stream, which is what makes it compatible with the stateless transport. For a change that warrants a real review surface, use elicitation's **URL mode** to point at the existing dashboard intent-confirmation page — that preserves the whole existing security property (dashboard session, capability re-check at execute, audit) rather than reimplementing a weaker one.

**Do not build a `confirm_intent` tool.** An agent able to call both propose and confirm reduces the human gate to the client's own approval dialog, which an auto-approving configuration defeats entirely.

Mark both tools with the specification's destructive/read-only annotations. **Read the current field names from the specification schema — do not write them from memory.**

- [ ] **Step 4: Run the tests and commit**

```bash
cd apps/api && nice -n 19 npx vitest run src/services/mcp --maxWorkers=2
git add apps/api/src
git commit -m "feat(mcp): propose-and-confirm experiment controls via elicitation"
```

---

### Task 10: Quota and the access trail

**Files:**
- Modify: `apps/api/src/services/copilot/quota.ts` (a new axis)
- Modify: `packages/db/src/drizzle/enums.ts` (`aggregate_type` gains `MCP_ACCESS`)
- Create: `packages/db/drizzle/migrations/<next>_mcp_access_aggregate.sql`
- Create: `apps/api/src/services/mcp/access-log.ts`
- Create: `packages/db/clickhouse/migrations/0025_mcp_access_log.sql`
- Test: `apps/api/src/services/mcp/access-log.integration.test.ts`

**Interfaces:**
- Consumes: `outboxRepo.insert(db, { aggregateType, aggregateId, eventType, payload })`, `resolveTier` / `evaluateQuota`.
- Produces: `recordMcpAccess(tx, entry)`.

- [ ] **Step 1: Write the failing test**

```ts
it("emits exactly one outbox row per tool call, in the same transaction", async () => {
  const before = await countOutbox(projectId, "MCP_ACCESS");
  await callTool(readToken, "list_experiments", {});
  expect(await countOutbox(projectId, "MCP_ACCESS")).toBe(before + 1);
});

it("writes ClickHouse only through the outbox", async () => {
  // The outbox is the ONLY path to Kafka in this codebase; a direct write
  // would bypass the dispatcher and lose the at-least-once guarantee.
  const source = readFileSync(ACCESS_LOG_PATH, "utf8");
  expect(source).not.toMatch(/clickhouse|insertInto/i);
});

it("records the tool and the actor but not the argument values", async () => {
  await callTool(readToken, "find_subscribers", { filter: { q: "alice@example.com" } });
  const row = await latestOutbox(projectId, "MCP_ACCESS");
  expect(row.payload.toolName).toBe("find_subscribers");
  expect(row.payload.userId).toBeTruthy();
  // An argument DIGEST, never the arguments: a query string can itself be
  // PII, and this row is destined for analytics storage.
  expect(JSON.stringify(row.payload)).not.toContain("alice@example.com");
});

it("counts MCP calls against the tier ladder, not a parallel limiter", async () => {
  const verdict = evaluateQuota({ ...baseInput, mcpCalls: OVER_TIER_LIMIT })  // axis name is snake_case;
  expect(verdict.exceeded).toBe("mcp_calls");
});
```

- [ ] **Step 2: Run it to verify it fails**, then implement.

**Two limits, not one — this is the resolution of R3.** `quotasUnlimited()`
returns `isSelfHosted()`, so the tier ladder is off on self-hosted instances.
Making the tier quota MCP's only ceiling would leave the primary abuse
control absent exactly where the endpoint is least likely to sit behind a
gateway.

1. **An abuse floor that ignores `quotasUnlimited()`** and applies in *both*
   modes: `MCP_MAX_CALLS_PER_TOKEN_PER_MONTH`, default `50_000`, env-overridable.
   This is not a billing limit and must not be wired into the tier ladder's
   billing semantics — a self-hoster who raises it is not buying anything.
2. **The tier ladder on top, cloud only**, as the billing instrument.

**The tier half reuses the existing ladder.** `resolveTier` / `evaluateQuota` already express tier-based monthly limits and already honour `quotasUnlimited()` from host-mode. Add an axis to `ExceededAxis`, which today is `"messages" | "input_tokens" | "output_tokens" | null` — so the new value is `"mcp_calls"`, matching its snake_case siblings. Do not build a second counting system with its own window — it would drift from the billing ladder the moment either changed. The global IP rate limit stays as a backstop only; per-IP is the wrong primary instrument when one agent bursts from one address and a shared office IP punishes unrelated users.

**The access trail does not go in `audit_logs`.** That table is a per-project append-only hash chain and a row per read would bloat it for no benefit. It goes to ClickHouse the only legitimate way: an `outbox_events` row the dispatcher publishes. `aggregate_type` is a Postgres enum, so it needs `ADD VALUE` — generate the migration with `pnpm db:migrate:generate` and run the journal watermark check.

Run the ClickHouse migration **from inside the compose network**, never the host.

- [ ] **Step 3: Run the tests and commit**

```bash
cd apps/api && nice -n 19 npx vitest run src/services/mcp --maxWorkers=2
cd packages/db && DATABASE_URL="$DATABASE_URL" nice -n 19 npx vitest run tests/journal-monotonic.test.ts --maxWorkers=2
git add apps/api/src packages/db
git commit -m "feat(mcp): per-token quota axis and an outbox-fed access trail"
```

---

### Task 11: The guards, and an eval set

**Files:**
- Create: `apps/api/src/services/mcp/mcp-surface.test.ts`
- Create: `apps/api/src/services/mcp/evals/tool-selection.md`
- Create: `apps/api/src/services/mcp/evals/run-eval.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the surface guard**

Structural, so it fails on a change made months from now by someone who never read this plan:

```ts
it("declares no primitive it does not implement", async () => {
  // Prompts are deliberately out of A. A server advertising `prompts`
  // makes clients call prompts/list and get a protocol error.
  const declared = await declaredCapabilities();
  const implemented = await implementedPrimitives();
  expect(declared.sort()).toEqual(implemented.sort());
});

it("every write tool is scope-gated and annotated", async () => {
  for (const name of await listMcpToolNames(writeToken)) {
    if (!WRITE_TOOLS.has(name)) continue;
    expect(await isRejectedForReadToken(name)).toBe(true);
    expect(await annotationsFor(name)).toHaveProperty(DESTRUCTIVE_ANNOTATION);
  }
});
```

- [ ] **Step 2: Prove the guard can fail**

Six guards in this repository's history turned out to be incapable of failing. Before finishing, deliberately declare `prompts` in the server's capabilities and confirm the first test goes red and names the mismatch; then revert. Put that evidence in your report. A guard that passes because it enumerated zero tools is worthless.

- [ ] **Step 3: Build the eval set**

Unit and integration tests prove each tool works **when called**. They cannot show that the right one gets called — which is the entire claim behind consolidating seventeen tools into eight.

Write `evals/tool-selection.md` as a table of realistic questions and the tool each should reach for:

| Question | Expected tool |
|---|---|
| "What was MRR last month?" | `get_metrics` |
| "Which experiment is winning?" | `list_experiments` |
| "Find the subscriber with id sub_123" | `find_subscribers` |
| "What does my paywall look like?" | `get_paywall` |
| "How many funnels do I have?" | `find_funnels` |
| "Stop the pricing experiment" | `stop_experiment` |

`run-eval.ts` drives a model against the served tool list and reports which tool it picked. This is a manual instrument, not a CI gate — model choice is not deterministic and pinning it would produce a flaky test that gets deleted.

Record the baseline in your report. If selection quality is poor, `list_audiences` and `list_feature_flags` are the first two to merge or drop, being furthest from the core story.

- [ ] **Step 4: Run the full suite once**

```bash
cd apps/api && nice -n 19 npx vitest run --maxWorkers=2
```

Record the pass/fail counts verbatim. Do not claim green without pasting the summary line.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "test(mcp): surface guard and a tool-selection eval set"
```

---

## Self-review notes

**Spec coverage.** D1 → Tasks 2, 11. D2 → Tasks 3, 4. D3 → Task 5. D4 → Tasks 6, 7. D4a (prompts omitted) → asserted in Tasks 2 and 11. D5 → Task 9. D6 → Task 10. D7 → Task 6 (sterilization); `run_analytics_query` is **not** in this plan at all, per the spec's condition that it ships only once bound to the read-only ClickHouse user with a column deny-list — it is a follow-up, not a task here. R1 → Task 1. R2 (prompt injection) → inherited posture, no new task. R3 (`HOST_MODE`) → **not covered; see below.**

**Known gaps in this plan, stated rather than hidden.**

1. **R3 is resolved** (2026-09-08): A ships in **both** modes, and Task 10 carries the consequence — an abuse floor independent of `quotasUnlimited()`, because that flag conflates "we do not bill you" with "unbounded is safe". No longer a blocker on Task 2.
2. **`get_metrics` is conditional on Task 1.** If Task 1 finds sandbox revenue contaminating ClickHouse, Task 6 ships seven tools instead of eight and a separate item opens. The plan does not pretend to know which.
3. **The SDK's API is not in this plan.** Task 2 records it; Tasks 6, 8 and 9 consume that record. If Task 2's findings contradict this plan's structure, the plan is what gives way.
4. **`user` cascade — checked, and it holds.** Task 3 cascades `mcp_tokens` on user deletion. The `user` table (`schema.ts:108-126`) has no soft-delete column, so deletion is a real DELETE and the cascade fires. Recorded because the opposite would have been a token outliving its owner's access, and "the FK will handle it" is exactly the kind of assumption worth one grep.

5. **`DESTRUCTIVE_ANNOTATION` in Task 11** is whatever Task 9 established after reading the specification schema. It is named, not defined, here on purpose — writing an annotation field name from memory is how the wrong one ships.
