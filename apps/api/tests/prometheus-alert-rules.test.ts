import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registry } from "../src/lib/metrics";

// =============================================================
// The alert rules must name metrics that actually exist
// =============================================================
//
// `deploy/prometheus/tests/slo_test.yml` proves each rule fires on the
// right synthetic series and stays quiet otherwise — but it feeds those
// series itself. A rule whose metric name does not match what the API
// exports passes every one of those tests and then never fires against
// a real Prometheus, because nothing ever produces the series it reads.
// That is the exact failure mode this repo keeps shipping: a guard that
// reads as coverage and cannot go off.
//
// So this closes the loop from the other side — every `rovenue_*` metric
// referenced by the rule file must be present in the API's own registry.

const RULES_FILE = fileURLToPath(
  new URL("../../../deploy/prometheus/rules/slo.yml", import.meta.url),
);

/** Every metric this project exports is prefixed. The rule file also
 *  references `http_requests_total` and the histogram's derived
 *  `_bucket` / `_count` series, which prom-client synthesises rather
 *  than registering under those names — matching on the prefix keeps
 *  the check to names that can be compared literally. */
const ROVENUE_METRIC_PATTERN = /\brovenue_[a-z0-9_]+\b/g;

function metricsReferencedByRules(): string[] {
  const source = readFileSync(RULES_FILE, "utf8");
  // Comment lines mention metric names in prose; only the executable
  // parts of the file can produce a rule that silently never matches.
  const executable = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  return [...new Set(executable.match(ROVENUE_METRIC_PATTERN) ?? [])].sort();
}

describe("prometheus alert rules", () => {
  it("reference only metrics the API actually exports", async () => {
    const exported = new Set(
      (await registry.getMetricsAsJSON()).map((m) => m.name),
    );
    const referenced = metricsReferencedByRules();

    // A rule file that references nothing would pass the loop below
    // vacuously. Anchor it: the partition gauges added alongside
    // migration 0130 are the reason this test exists.
    expect(referenced).toContain("rovenue_partition_premake_months_remaining");
    expect(referenced).toContain("rovenue_partition_default_rows");
    expect(referenced).toContain("rovenue_partition_maintenance_partman_ran");

    const missing = referenced.filter((name) => !exported.has(name));
    expect(
      missing,
      `deploy/prometheus/rules/slo.yml alerts on metrics the API never ` +
        `exports, so these rules can never fire: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
