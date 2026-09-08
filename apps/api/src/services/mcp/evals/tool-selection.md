# MCP tool-selection eval

Manual instrument, not a CI gate: model choice is not deterministic and
pinning it would produce a flaky test that gets deleted. Run with
`pnpm --filter @rovenue/api eval:mcp` (see `run-eval.ts`) when
`ROVI_DEFAULT_PROVIDER`, `ROVI_DEFAULT_MODEL` and `ROVI_DEFAULT_API_KEY`
are set; otherwise work the table by hand.

The table covers the SHIPPED surface (10 tools). `get_metrics` is
deliberately absent: it never shipped (blocked on the R1 sandbox fix —
the metric chat tools stay chat-only), so no row may expect it. The MRR
row below records that gap instead of pretending.

| # | Question | Expected tool |
|---|----------|---------------|
| 1 | Which experiment is winning? | `list_experiments` |
| 2 | Find the subscriber with id sub_123 | `find_subscribers` |
| 3 | What does my paywall look like? | `get_paywall` |
| 4 | How many funnels do I have? | `find_funnels` |
| 5 | Stop the pricing experiment | `stop_experiment` |
| 6 | Start the onboarding experiment | `start_experiment` |
| 7 | What products are in the catalog? | `list_catalog` |
| 8 | Which audiences exist? | `list_audiences` |
| 9 | What feature flags are on? | `list_feature_flags` |
| 10 | Show me active subscriptions | `list_subscriptions` |
| 11 | What was MRR last month? | *(no covering tool — known gap)* |

Notes for the runner:

- Rows 5–6 must reach the WRITE tools, not a read: proposing via
  `stop_experiment` / `start_experiment` (input_required) is correct;
  answering from `list_experiments` alone is a miss.
- Row 11 is a control: a good result names the gap ("no metric tool")
  rather than hallucinating numbers from an unrelated tool.
- If selection quality is poor, `list_audiences` and
  `list_feature_flags` are the first two to merge or drop, being
  furthest from the core story.

## Baseline (2026-09-08)

Not run: no model credentials in this environment (the runner refuses
without `ROVI_DEFAULT_API_KEY`). First run with credentials records
picked-vs-expected per row here.
