import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================
// Fixed host-port registry
// =============================================================
//
// A handful of integration suites start their own Redpanda/ClickHouse
// containers on FIXED host ports rather than letting testcontainers map a
// random one. That is not laziness: a Kafka client connects on the address
// the broker advertises, so the advertised listener has to name a port that
// is known before the container starts.
//
// The cost is that two suites pinning the same port cannot run at the same
// time, and vitest runs files in parallel. Until now the allocations were
// tracked only in a comment at the top of each file — several of which say
// "NOT parallel-safe: binds host port N" and even cross-reference each other
// — and that registry drifted: `notifier` and `ch-kafka-engine` both took
// 19094, `notifier-entry` and `outbox-replay-idempotency` both took 19095.
//
// The collision is invisible until the two land in the same wave of workers,
// at which point the loser dies with "Bind for 0.0.0.0:19094 failed: port is
// already allocated" — an infrastructure error that looks nothing like the
// suite it kills, and that moves to a different file on the next run because
// the scheduling changed. It reads exactly like flakiness.
//
// So the registry is asserted here instead of documented.

const testsRoot = fileURLToPath(new URL("..", import.meta.url));

/** `const externalPort = 19102;`, `const BROKER_EXTERNAL_PORT = 19094;`,
 *  `const CH_HOST_PORT = 8228;` — a declaration binding a literal host port.
 *  Ports below 1024 and ordinary app ports (3000) are not in this range; the
 *  suites deliberately allocate out of 8xxx and 19xxx. */
const PORT_DECL = /^\s*(?:const\s+)?(\w*(?:[Pp]ort|PORT)\w*)\s*(?:=|:)\s*(1[0-9]{4}|8[0-9]{3})\b/;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("fixed host-port allocations", () => {
  it("are unique across test files", async () => {
    const files = await walk(testsRoot);
    /** port -> files that pin it */
    const owners = new Map<number, Set<string>>();

    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const line of content.split("\n")) {
        // Skip comments: the headers quote other suites' ports on purpose.
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
        const m = PORT_DECL.exec(line);
        if (!m) continue;
        const port = Number(m[2]);
        const set = owners.get(port) ?? new Set<string>();
        set.add(relative(testsRoot, file));
        owners.set(port, set);
      }
    }

    // Guards the scanner as much as the registry: a regex that silently
    // stopped matching would make the uniqueness assertion vacuous.
    expect(owners.size, "no pinned host ports found — check PORT_DECL").
      toBeGreaterThanOrEqual(8);

    const clashes = [...owners]
      .filter(([, fs]) => fs.size > 1)
      .map(([port, fs]) => `${port}: ${[...fs].join(" + ")}`);

    expect(
      clashes,
      `two suites cannot pin the same host port — they die with "port is ` +
        `already allocated" whenever vitest schedules them together:\n` +
        clashes.join("\n"),
    ).toEqual([]);
  });
});
