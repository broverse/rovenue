import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(
  new URL("../clickhouse/migrations", import.meta.url),
);

describe("ClickHouse migrations", () => {
  it("are numbered contiguously from 0001", async () => {
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.length, "at least 0001 must exist").toBeGreaterThan(0);
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    for (let i = 0; i < numbers.length; i += 1) {
      expect(numbers[i]).toBe(i + 1);
    }
  });

  it("contain no multi-line statements with semicolons mid-line", async () => {
    const files = (await readdir(migrationsDir)).filter((f) =>
      f.endsWith(".sql"),
    );
    for (const file of files) {
      const content = await readFile(join(migrationsDir, file), "utf8");
      // Forbid `;` that isn't at end of a line — the runner splits on
      // end-of-line semicolons only; a mid-line `;` would corrupt
      // multi-statement splitting.
      const offenders = content
        .split("\n")
        .filter(
          (line) =>
            line.includes(";") &&
            !line.trimEnd().endsWith(";") &&
            !line.trim().startsWith("--"),
        );
      expect(offenders, `mid-line semicolon in ${file}`).toHaveLength(0);
    }
  });

  it("each non-empty statement is either a comment or starts with a CH DDL keyword", async () => {
    const files = (await readdir(migrationsDir)).filter((f) =>
      f.endsWith(".sql"),
    );
    const ddlKeywords = [
      "CREATE",
      "ALTER",
      "DROP",
      "RENAME",
      "ATTACH",
      "DETACH",
      "TRUNCATE",
      "OPTIMIZE",
      "GRANT",
      "REVOKE",
    ];
    for (const file of files) {
      const content = await readFile(join(migrationsDir, file), "utf8");
      const statements = content
        .split(/;\s*$/m)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        if (stmt.startsWith("--")) continue;
        const head = stmt.replace(/^--[^\n]*\n/gm, "").trim().toUpperCase();
        const matches = ddlKeywords.some((kw) => head.startsWith(kw));
        expect(matches, `non-DDL statement in ${file}: ${stmt.slice(0, 60)}...`)
          .toBe(true);
      }
    }
  });

  // A Kafka engine table with no `kafka_flush_interval_ms` silently inherits
  // `stream_flush_interval_ms`, whose default is 7500ms. That interval is the
  // dominant term in ingestion freshness — it is what put end-to-end p95 at
  // 6.06s against a 5s budget before 0021 set it explicitly. The omission is
  // invisible in review and in the schema; nothing fails, data just arrives
  // late. So it is asserted here instead.
  //
  // The check looks at the LAST definition of each table across the migration
  // chain, because a later migration recreating a queue table is exactly how
  // the setting gets applied (Kafka tables reject ALTER ... MODIFY SETTING).
  it("every Kafka engine table sets kafka_flush_interval_ms", async () => {
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    /** table name -> whether its most recent CREATE declares the setting */
    const declared = new Map<string, boolean>();

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      for (const stmt of sql.split(/;\s*$/m)) {
        // Strip comment lines so a setting named only in prose never counts.
        const body = stmt
          .split("\n")
          .filter((l) => !l.trim().startsWith("--"))
          .join("\n");
        if (!/ENGINE\s*=\s*Kafka/i.test(body)) continue;
        const name = /CREATE TABLE (?:IF NOT EXISTS )?(\S+)/i.exec(body)?.[1];
        if (!name) continue;
        declared.set(name, /kafka_flush_interval_ms\s*=/i.test(body));
      }
    }

    expect(declared.size, "no Kafka engine tables found — check the parser")
      .toBeGreaterThanOrEqual(5);

    const missing = [...declared]
      .filter(([, hasSetting]) => !hasSetting)
      .map(([name]) => name);
    expect(missing, `Kafka tables without kafka_flush_interval_ms: ${missing.join(", ")}`)
      .toEqual([]);
  });
});
