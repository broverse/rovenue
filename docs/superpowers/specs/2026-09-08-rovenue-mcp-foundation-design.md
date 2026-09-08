# Rovenue MCP server — foundation

**Date:** 2026-09-08
**Status:** Design, not yet planned
**Sub-project:** A of 3

---

## Where this sits

Brainstorming a Rovenue MCP server decomposed into three sub-projects once
it became clear that what blocked agent-authored paywalls was not MCP:

| | Sub-project | Depends on | Status |
|---|---|---|---|
| **A** | **MCP foundation — transport, token auth, read tools, experiment control (this spec)** | — | designed |
| B | Server-side authoring paths — no MCP in it | — | **shipped 2026-09-08** |
| C | MCP authoring tools (`create_paywall`, `edit_funnel`, …) | A + B | not started |

B shipped: paywall tree edits now persist server-side through the copilot
intent handler, drafts carry `draftRevision` with a 409 on conflict, and
paywall/funnel mutations sit behind `paywalls:write` / `funnels:write`.
This spec builds the surface an external agent talks to. **It deliberately
excludes authoring tools** — those are C, and they depend on this.

## Goal

A Rovenue customer connects their own MCP client (Claude Code, Claude
Desktop, Cursor) to their own project and asks questions about their
subscription business — and can start and stop experiments. Reading is the
bulk of it; the only writes in A are the two experiment controls, chosen
because they are the only `action_*` tools whose intent handlers already
execute server-side.

## Decisions already taken

These were settled during brainstorming and are inputs, not open questions:

- **Product feature**, not internal tooling: the MCP client is in the
  customer's hands.
- **Remote, inside `apps/api`**, not a separately-distributed local stdio
  bridge. It ships with every self-host automatically and versions with the
  API.
- **A new, user-bound token kind** rather than the existing per-project
  SECRET key.
- **Tools plus resources**, not tools alone.
- **One project per token**, baked in at creation.

---

## Design

### D1 — Transport

Streamable HTTP, mounted at `/mcp` in `apps/api`, using the official
`@modelcontextprotocol/sdk`. Do not hand-roll JSON-RPC: the SDK carries
discovery, notifications and error codes, all of which are easy to get
subtly wrong by hand.

**Discovery is `server/discover`, not an initialize handshake.** The
`initialize`/`initialized` exchange and the `Mcp-Session-Id` header were
**retired** in the 2026-07-28 revision; a client calls `server/discover` to
learn the server's supported versions and capabilities before doing anything
else. An earlier draft of this design described the retired handshake — do
not carry that mental model into implementation, and do not write a contract
test against it.

**Use the SDK's Hono middleware.** The SDK publishes optional middleware for
specific runtimes and frameworks including Hono. Reaching into
`@hono/node-server`'s raw `c.env.incoming` / `c.env.outgoing` to bridge to
the Node-style transport is not merely unnecessary — it would bypass Hono's
response pipeline, so `metricsMiddleware`, `requestLoggerMiddleware` and the
error middleware would observe a response that never happens.

*Verify at implementation time:* the exact package name and that the Hono
middleware is in a released version, not only in docs. If it is not, the
fallback is the Node transport plus an explicit decision about what the
bypassed middleware costs — not a silent bridge.

**Stateless.** A new transport and server instance per request; the SDK
documents that sharing one instance causes request-id collisions between
concurrent clients. This is not a trade-off being chosen against the grain:
the 2026-07-28 revision moved the protocol to a **stateless core** that runs
on ordinary HTTP infrastructure, and retiring `Mcp-Session-Id` is part of
that. It also happens to be what Rovenue needs — the API may run multiple
replicas behind a load balancer, where a session in one process's memory
would break.

**Advertise capabilities honestly at discovery.** The server declares only
the primitives it actually implements (see D4a on prompts) and a `name`,
`version` and `instructions` string. `instructions` is the one place to tell
a client's model how this server expects to be used — that a token is scoped
to exactly one project, that reads are sterilized, that writes require a
confirmation step. Write it deliberately; it is part of the interface, not
boilerplate. A contract test pins the declared capability set so a primitive
cannot be advertised without being implemented.

**Validate the `Origin` header.** HTTP transports are exposed to DNS
rebinding; this is not optional and was missing from the first draft of this
design.

**No OAuth metadata document.** The MCP specification's authorization model
is OAuth 2.1, where the server is a resource server that verifies tokens it
did not issue. A is deliberately outside that model (see D2). Publishing a
`/.well-known/oauth-protected-resource` stub for an authorization server that
does not exist would be actively harmful: a conformant client that discovers
it attempts an OAuth flow and fails, where it would otherwise have sent its
bearer token successfully. Build the verifier as a `TokenVerifier`-shaped
seam so OAuth can slot in later without re-plumbing, but advertise nothing.

**Never accept a token Rovenue did not issue.** Token passthrough is
explicitly forbidden by the specification (the confused-deputy problem);
validate the audience.

### D2 — Authentication: a separate `mcp_tokens` table

A new table, not a third kind in `api_keys`.

The decisive argument is blast radius, not convenience. `apiKeyAuth("any")`
classifies a key by prefix and accepts PUBLIC or SECRET. Adding a third kind
to the same table means every `/v1/*` route using `"any"` begins accepting
MCP tokens unless every call site is audited. A separate table plus a
distinct `rov_mcp_` prefix means `apiKeyAuth` cannot classify the token and
**fails closed** — the behaviour we want. It also avoids carrying
`api_keys`'s `environment` and `allowedOrigins` columns, which are
meaningless here.

```
mcp_tokens: id, projectId, userId, label, scope,
            tokenPublic (unique), tokenSecretHash,
            lastUsedAt, expiresAt, revokedAt, createdAt, updatedAt
```

- `userId` is why this table exists: it makes the audit actor a real person
  rather than "an API key".
- `scope` is `read` | `read_write`. A token must be able to be read-only
  even when its owner is an OWNER — least privilege applies to the token,
  not only to the human.
- The secret is shown **once**, at creation.
- `revokedAt` takes effect immediately because the server is stateless and
  re-checks on every request.

### D3 — Authorization resolved per request

The token carries **no baked-in role**. Every request runs
`assertProjectAccess(token.projectId, token.userId)`; if the user is demoted
or removed from the project, the token dies with it. A token that carried a
snapshot of its owner's role would be stale privilege.

**Write tools inherit the capability the dashboard uses.** B introduced
`requiresCapability` on copilot intents and moved paywall/funnel mutations
onto `paywalls:write` / `funnels:write`. A's write tools go through the same
gate rather than inventing a parallel policy — the whole point of B was to
stop the same mutation answering to two different gates.

**Read tools have no existing policy to inherit, and that is a hole, not an
inheritance.** The copilot's `query_*` tools carry no role gate at all. A
must not silently copy that. The rule for A: a role sees through MCP exactly
what it sees in the dashboard — no more, no less. Where the dashboard itself
has no read differentiation, A inherits that and the gap is recorded as a
dashboard-side product question, not patched here.

### D4 — Tool surface: consolidated, not mirrored

Anthropic's guidance is to build few, workflow-shaped tools rather than
mirroring an existing API or registry, and the reason is measurable: with
dozens of tools, JSON schemas can consume 40–50% of the model's context,
raising cost and latency while *reducing* accuracy. The copilot's registry
is chat-shaped, not agent-shaped, and mirroring its 17 tools would be the
anti-pattern.

| MCP tool | Consolidates |
|---|---|
| `get_metrics` | `query_metrics_mrr` + `_churn` + `_conversion` — the three already share one `DateRangeArgs`, so a `metric` enum is the natural shape |
| `find_subscribers` | `query_subscribers_search` + `_get` |
| `list_subscriptions` | `query_subscriptions_list` |
| `list_catalog` | `query_products_list` + `query_productGroups_list` — both in one call beats two round trips |
| `list_audiences` | `query_audiences_list` |
| `list_feature_flags` | `query_featureFlags_list` |
| `list_experiments` | `query_experiments_list` |
| `get_paywall` | `query_paywall_tree`, with the builder-route gate removed |
| `find_funnels` | *new* — funnels have no copilot read tool at all |
| `start_experiment`, `stop_experiment` | `action_experiments_start` / `_stop`, kept separate so their annotations can differ |
| `run_analytics_query` | *new* — the escape hatch for questions the fixed metric tools do not cover, with `mode: "schema" \| "query"`. **Ships only if D7's two mechanisms are in place**; see below |

Twelve tools if `run_analytics_query` ships, eleven if it does not. Nothing
else depends on it.

Merging `list_audiences` and `list_feature_flags` under one "targeting" tool
was considered and rejected: they are conceptually different and a merged
tool would mislead the model. The guidance is minimal *overlap*, not minimal
count at any cost.

**Not carried over:** every `ui_*` tool (chat-only), and every `action_*`
tool outside A's scope. Note that `intent-handlers.ts`'s own header marks
`action.subscriptions.cancel`, `.refund` and `action.subscribers.transfer`
as **STUB** — that claim must be verified before anyone relies on those
tools anywhere, and it is a reason not to expose them here.

**Resources:** `rovenue://paywall/{id}`, `rovenue://catalog/products`,
`rovenue://experiments`, `rovenue://schema/clickhouse`. Client support for
resources is uneven, so **every resource is mirrored by a tool** — nothing
load-bearing may live only in a resource.

One consequence to hold: `rovenue://schema/clickhouse`'s mirror is
`run_analytics_query`'s `mode: "schema"`. If D7 keeps that tool out of A,
that resource leaves with it rather than shipping unmirrored.

**Per-tool requirements:**

- Pagination with a hard cap, and truncation stated explicitly in the
  response (`"47 of 1,203 rows"`), never silent. **Concrete defaults, so an
  implementer does not invent them:** 50 rows per page, 200 maximum, and a
  256 KB response ceiling whichever comes first. `run_analytics_query`, if it
  ships, gets 1,000 rows and 1 MB — larger because its whole purpose is the
  question the fixed tools cannot answer, and still bounded because an
  unbounded result would blow the model's context in one call.
- Return ids the agent can use in a follow-up call, not opaque blobs.
- **Distinguish a failed tool from a failed protocol.** MCP separates a tool
  that ran and returned an error (`isError` on the result, which the model
  sees and can act on) from a protocol-level error (which it cannot). A
  subscriber that does not exist, a date range with no data, a query the
  deny-list rejects — all of these are tool results the model should read and
  react to, not transport failures. Reserve protocol errors for
  authentication, authorization and malformed requests. Getting this backwards
  makes an agent retry things that will never succeed.
- Error text tells the model what to do next — "`experimentId` not found; call
  `list_experiments` for valid ids" — not just a status code.
- Write tools carry the specification's destructive/read-only annotations.
  *Verify the current annotation field names against the specification
  schema at implementation time rather than writing them from memory.*

### D4a — Prompts are deliberately out of A

MCP servers expose three primitives: tools, resources and **prompts**. This
design implements two. Prompts are the one primitive that is *user*-selected
rather than model-selected — a menu the person picks from — which makes them
the natural answer to "twelve tools, what do I even ask?"

They are still out of A, and the reason is scope rather than merit: A already
carries a transport, a token subsystem with its own migration, twelve tools,
four resources, quota and an access-log pipeline. Prompts add a third
primitive to implement, test and version, and they block nothing — a user can
ask in natural language today, and the tool descriptions do that work.

Recorded as the first candidate for the sub-project after C. If it turns out
customers cannot find the surface, that is the evidence to add them, and a
prompt composes existing tools rather than needing new backend logic.

**This is an omission with a reason, not an oversight.** An earlier draft of
this spec simply did not mention prompts at all.

### D5 — Writes go through the intent flow, with in-band elicitation

The two write tools do not mutate directly. They create a copilot intent —
preview, `requiresCapability`, expiry, status machine — exactly as the
dashboard does, and then the server asks the user to confirm.

Confirmation uses **elicitation**, which in the current specification
revision works through multi-round-trip requests: the handler returns
`inputRequired(...)` and the client re-issues the original call with the
responses and the echoed request state. There is no persistent bidirectional
stream, which is what makes this compatible with the stateless transport in
D1.

For anything that warrants a real review surface, use elicitation's **URL
mode**, which exists for interactions that must not pass through the MCP
client: point the user at the existing dashboard intent-confirmation page.
That preserves the entire existing security property — dashboard session,
capability re-check at execute time, audit — rather than reimplementing a
weaker confirmation inside MCP.

**Do not build a `confirm_intent` tool.** An agent that can call both
propose and confirm reduces the human gate to the client's own approval
dialog, which an auto-approving configuration defeats entirely. The
specification solves this properly; a hand-rolled substitute would be
strictly weaker.

### D6 — Quota and the read trail

**Quota is per token, not per IP.** One agent bursts many tool calls from
one address, and a shared office IP would punish unrelated users. The global
IP rate limit still applies as a backstop; it is the wrong primary
instrument.

**Reuse the existing quota ladder — do not build a parallel limiter.**
`resolveTier` / `evaluateQuota` (`services/copilot/quota.ts`) already express
tier-based monthly limits and already honour `quotasUnlimited()` from
host-mode. MCP adds a new axis to `ExceededAxis`, not a second counting
system with its own window and its own numbers. A parallel per-hour limiter
would drift from the billing ladder the moment either changed.

**Reads leave a trail, but not in `audit_logs`.** That table is a per-project
append-only hash chain; writing a row per read would bloat the chain and is
not what it is for. A separate access record — token id, user id, tool name,
argument digest, row count, duration — belongs in ClickHouse, reached the
only legitimate way: an `outbox_events` row that the dispatcher publishes.
Never write a domain table and Kafka in the same code path.

This matters because MCP moves data out of the instance to a third-party
model provider, and this repo already carries DSAR/erasure machinery that
assumes such movement is accounted for.

### D7 — Data protection

**`sterilizeToolResult` stays on.** In the copilot, Rovenue calls the model;
over MCP the customer's own agent does — but the data still leaves the
instance to a third-party provider, and now without Rovenue mediating. Email,
IP, device id and the rest keep being stripped by default.

**The exception that breaks the guarantee: `run_analytics_query`.**
`sterilizeToolResult` matches on *field names*. An agent writing its own SQL
can defeat it with `SELECT email AS x`. So the guarantee this design makes
everywhere else is void for exactly the highest-risk tool — free SQL over the
customer's whole dataset, leaving the instance.

The answer cannot be sterilization; it has to be the database. Two mechanisms
are available and the spec requires both:

1. **Bind the tool to the read-only ClickHouse user.** `.env.example`
   already defaults `CLICKHOUSE_USER=rovenue_reader`, which cannot run DDL.
2. **A column deny-list enforced server-side**, rejecting a query that
   references PII columns, rather than trusting the agent's SQL.

**`run_analytics_query` does not ship until both are in place.** If that
proves larger than expected, it leaves A and becomes its own item — with
`rovenue://schema/clickhouse` — and the remaining eleven tools are unaffected.

**On long-running queries.** The 2026-07-28 revision adds a Tasks extension
for work that outlives a single request, and an analytics query over a large
dataset is the shape it exists for. A does **not** adopt it: the 1 MB / 1,000
row ceiling above already bounds the work, and a query that cannot finish
inside a normal request timeout under those bounds is a query that should be
rejected rather than backgrounded. Recorded so the next author knows it was
considered, not missed.

---

## Named risks

**R1 — Sandbox and production revenue are indistinguishable in analytics.**
`purchases` carries an `environment` column, but the ClickHouse schema has
**no environment dimension at all** (no migration under
`packages/db/clickhouse/migrations` mentions one), and `listDailyMrr` — the
service behind the copilot's MRR tool — does not filter on it either.

A does not create this. A *amplifies* it: today the numbers are read by a
person inside a dashboard; A hands them to an agent that will state them as
fact, to a user with no context to notice. **This must be resolved before
`get_metrics` ships** — either by establishing that sandbox purchases never
reach ClickHouse, or by adding the dimension. Do not ship a metrics tool over
numbers whose environment semantics are unverified.

**And it gets the same exit ramp as `run_analytics_query`:** if resolving it
turns out to be its own project, `get_metrics` leaves A and the remaining
tools ship without it. An earlier draft gave one blocked tool an exit and not
the other, which was inconsistent — a tool blocked on an unresolved data
question is in the same position whichever question it is.

**R2 — Tool results are untrusted input to the customer's own agent.**
Subscriber custom attributes, paywall copy and imported CSV fields are all
user-supplied and can carry prompt injection through MCP into the customer's
client. The copilot already has `prompt-injection.integration.test.ts`; A
inherits that posture deliberately, not by accident.

**R3 — `HOST_MODE` (self | cloud) was never considered in the original
sketch.** Exposing `/mcp` on a self-hosted instance behind a firewall and on
the cloud offering are different problems with different auth expectations.
Decide explicitly whether A ships in both modes at once.

**R4 — The three-platform decoder contract.** `assertSaveValid`'s node and
depth bound was closed in B. Whether its blocking set covers
`packages/shared/src/paywall/render-fixtures.json` remains open. It does not
block A, which writes no paywall content — but it gates C.

---

## Out of scope

- Every authoring tool: `create_paywall`, `edit_paywall`, `publish_paywall`,
  `create_funnel`, `edit_funnel`, `publish_funnel`. Those are C.
- OAuth 2.1 and Enterprise-Managed Authorization. D1 leaves the seam; the
  flow is a later sub-project.
- A local stdio bridge. Remote-only was decided.
- Exposing subscriber/subscription **writes** (cancel, refund, transfer,
  grant access) — outside the chosen scope, and their handlers may be stubs.
- Fixing the dashboard's lack of read-role differentiation (D3).

---

## Testing

- **Token lifecycle against real Postgres**: creation, one-time secret
  display, revocation taking effect on the next request, expiry.
- **Authorization is resolved per request**: demote the user mid-session and
  the next call fails. A mocked membership lookup cannot show this.
- **`apiKeyAuth` rejects an MCP token** and vice versa — the fail-closed
  property that justifies the separate table. Assert it, do not assume it.
- **Scope is enforced**: a `read` token cannot reach a write tool even when
  its owner holds the capability.
- **Stateless isolation**: two concurrent clients do not collide on request
  ids — the specific failure the SDK warns about when a transport is shared.
- **Truncation is stated**: a capped response says so rather than silently
  returning a prefix.
- **Sterilization holds** across every tool that returns subscriber data,
  and `run_analytics_query`'s deny-list rejects an aliased PII column
  (`SELECT email AS x`) — the exact bypass that motivates D7.
- **Declared capabilities match implemented primitives** — the server cannot
  advertise a primitive it does not serve (see D4a: prompts are not declared).
- **`Origin` rejection** for a disallowed origin.
- **The access trail is actually written.** D6 specifies an `outbox_events`
  row per tool call that the dispatcher publishes to ClickHouse. Assert the
  row is emitted in the same transaction as the call it records, and that no
  code path writes ClickHouse directly — the outbox is the only route. An
  earlier draft of this spec designed this pipeline and then tested none of
  it.

**Tool-selection evals, separate from the test suite.** This design claims
that consolidating seventeen chat-shaped tools into twelve agent-shaped ones
improves the model's accuracy. Unit and integration tests cannot show that —
they prove each tool works when called, not that the right one gets called.
Build a small eval set of real questions ("what was MRR last month", "which
experiment is winning", "find the subscriber with this id") and check which
tool the model reaches for. This is also the instrument that decides the
open question in D4: if selection quality degrades, `list_audiences` and
`list_feature_flags` are the first two to merge or drop, being furthest from
the core story.

## Migration and rollout

- One migration for `mcp_tokens`. Check it against the drizzle journal
  watermark before considering it done — migrations in this repo have
  historically landed below the watermark and been silently skipped on
  databases with existing history. `packages/db/tests/journal-monotonic.test.ts`
  now guards this; make sure it runs.
- The ClickHouse access-log table needs its own migration, run from **inside
  the compose network** — `deploy/clickhouse/users.d/rovenue.xml` allow-lists
  loopback plus private ranges, and Docker Desktop host traffic arrives from
  an address ClickHouse rejects, reporting it to clients as "password is
  incorrect".
- `/mcp` mounts after `/dashboard` in `app.ts`. Hono matches by registration
  order, not path specificity; `/mcp` has its own prefix so it avoids the
  trap that forces `paywallPreviewRoute` to be registered before `/v1`, but
  its auth middleware must stay scoped inside the mounted subtree.
- No deployment ordering constraint: nothing outside `/mcp` reads the new
  table.

## Open questions

- **R1's resolution** — does sandbox revenue reach ClickHouse? Blocks
  `get_metrics` (which now has an exit ramp if the answer is expensive).
- **The SDK's Hono middleware** — released, or docs-only? Blocks D1's shape.
  This is the one remaining claim in this spec taken from documentation prose
  rather than verified against a package.
- **Annotation field names** in the current specification revision. Blocks
  D4's write-tool metadata. Write them from the schema, not from memory.
- **R3** — does A ship in self-host, cloud, or both at once?

*Confirmed while revising:* 2026-07-28 is still the current specification
revision, and its retirement of `initialize` / `Mcp-Session-Id` in favour of
`server/discover` is now reflected in D1.
