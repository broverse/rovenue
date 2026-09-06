#!/usr/bin/env tsx
/**
 * Standalone, offline verifier for an audit-proof bundle
 * (`GET /dashboard/audit-logs/proof`, ROADMAP §9.3).
 *
 * An auditor running this is explicitly NOT trusting the server that
 * produced the bundle: the actual verification logic (`verifyAuditBundle`)
 * lives in `@rovenue/shared/audit-chain`, which itself hits only
 * `node:crypto` — nothing from `apps/api`, nothing from `packages/db`.
 * This file is now just the CLI wrapper (read the file, print the
 * result, set the exit code); the same `verifyAuditBundle` this wraps
 * is also what `apps/api`'s own tests run over a CHECKPOINT_TRUNCATE
 * bundle (ROADMAP §9.2 Task 5) — one verifier, not a second copy that
 * could silently drift.
 *
 * Usage:
 *   tsx verify-audit-bundle.ts <path-to-bundle.json>
 *   pnpm --filter @rovenue/scripts verify:audit-bundle <path-to-bundle.json>
 */
import { readFileSync } from "node:fs";
import { verifyAuditBundle, type VerifyResult } from "@rovenue/shared/audit-chain";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

export { verifyAuditBundle };
export type {
  VerifyFailure,
  VerifyFailureReason,
  VerifyResult,
} from "@rovenue/shared/audit-chain";

function printResult(result: VerifyResult, path: string): void {
  console.log(`bundle: ${path}`);
  console.log(`truncated: ${result.truncated}`);
  if (result.ok) {
    console.log(`OK -- ${result.entriesChecked} entries verified`);
    return;
  }
  console.error(`FAIL -- ${result.entriesChecked} entries verified before failure`);
  if (result.failure) {
    const { index, entryId, reason } = result.failure;
    if (index === null) {
      // A whole-bundle failure: nothing entry-specific to point at.
      console.error(`  ${reason}`);
    } else {
      console.error(`  entry #${index} (${entryId}): ${reason}`);
    }
  }
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: verify-audit-bundle.ts <path-to-bundle.json>");
    process.exit(EXIT_FAILURE);
  }

  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`failed to read/parse ${path}: ${(err as Error).message}`);
    process.exit(EXIT_FAILURE);
  }

  const result = verifyAuditBundle(bundle);
  printResult(result, path);
  process.exit(result.ok ? EXIT_SUCCESS : EXIT_FAILURE);
}

const isMainModule = process.argv[1]?.endsWith("verify-audit-bundle.ts");
if (isMainModule) {
  main();
}
