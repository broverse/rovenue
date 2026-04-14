#!/usr/bin/env tsx
/**
 * Key rotation for project credentials.
 *
 * Decrypts every project credential column with the OLD key and
 * re-encrypts with the NEW key. Idempotent: rows already readable
 * with the new key are left alone, so partial runs are safe to
 * restart.
 *
 * Usage:
 *   OLD_KEY=<hex> NEW_KEY=<hex> tsx scripts/rotate-encryption-key.ts
 *   OLD_KEY=<hex> NEW_KEY=<hex> tsx scripts/rotate-encryption-key.ts --dry-run
 *
 * After a successful run, update the deployed ENCRYPTION_KEY env
 * variable to NEW_KEY and restart the API.
 */

import prisma, {
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} from "@rovenue/db";

const CREDENTIAL_FIELDS = [
  "appleCredentials",
  "googleCredentials",
  "stripeCredentials",
] as const;

type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

function requireHexKey(name: string): string {
  const value = process.env[name];
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be 64 hex chars (32 bytes)`);
  }
  return value;
}

function rotateValue(
  value: unknown,
  oldKey: string,
  newKey: string,
): { next: unknown; changed: boolean } {
  if (value === null || value === undefined) {
    return { next: null, changed: false };
  }
  if (isEncryptedCredential(value)) {
    try {
      decryptCredential(value, newKey);
      return { next: value, changed: false };
    } catch {
      // fall through — not yet rotated
    }
  }
  const plain = decryptCredential<unknown>(value, oldKey);
  if (plain === null || plain === undefined) {
    return { next: null, changed: false };
  }
  return { next: encryptCredential(plain, newKey), changed: true };
}

async function main(): Promise<void> {
  const oldKey = requireHexKey("OLD_KEY");
  const newKey = requireHexKey("NEW_KEY");
  const dryRun = process.argv.includes("--dry-run");

  if (oldKey === newKey) {
    throw new Error("OLD_KEY and NEW_KEY are identical — nothing to do");
  }

  const projects = await prisma.project.findMany({
    select: {
      id: true,
      name: true,
      appleCredentials: true,
      googleCredentials: true,
      stripeCredentials: true,
    },
  });

  let rotated = 0;
  let skipped = 0;
  let failed = 0;

  for (const project of projects) {
    const updates: Partial<Record<CredentialField, unknown>> = {};
    let projectChanged = false;

    try {
      for (const field of CREDENTIAL_FIELDS) {
        const { next, changed } = rotateValue(project[field], oldKey, newKey);
        if (changed) {
          updates[field] = next;
          projectChanged = true;
        }
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[FAIL] ${project.id} (${project.name}) — ${(err as Error).message}`,
      );
      continue;
    }

    if (!projectChanged) {
      skipped += 1;
      continue;
    }

    if (dryRun) {
      rotated += 1;
      console.log(
        `[DRY] would rotate ${project.id} (${project.name}): ${Object.keys(updates).join(", ")}`,
      );
      continue;
    }

    await prisma.project.update({
      where: { id: project.id },
      data: updates as Record<string, unknown>,
    });
    rotated += 1;
    console.log(
      `[OK]  rotated ${project.id} (${project.name}): ${Object.keys(updates).join(", ")}`,
    );
  }

  console.log(
    `\nDone. rotated=${rotated} skipped=${skipped} failed=${failed} total=${projects.length}${dryRun ? " (dry-run)" : ""}`,
  );

  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
