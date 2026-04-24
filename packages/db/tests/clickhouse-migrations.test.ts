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
});
