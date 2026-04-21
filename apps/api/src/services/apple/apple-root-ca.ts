import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { assertAppleRootFingerprints } from "./apple-root-fingerprints";

const log = logger.child("apple-root-ca");

const VALID_EXTENSIONS = [".cer", ".pem", ".crt", ".der"];

let cache: Buffer[] | null = null;
let loaded = false;

/**
 * Load Apple root CA certificates from `APPLE_ROOT_CERTS_DIR`. Required by
 * `SignedDataVerifier` for full x5c chain validation of App Store Server
 * Notifications V2 and StoreKit 2 signed transactions.
 *
 * Returns `null` when the env var is unset or the directory has no cert
 * files — callers must decide whether to fail closed (production) or fall
 * back to the jose verifier (dev/test).
 *
 * Throws when the loaded cert bytes do not match the pinned SHA-256
 * fingerprints in `apple-root-fingerprints.ts`. A mismatch is a
 * deployment-integrity failure (tampered image, wrong bundled cert, or
 * a future Apple rotation we haven't pinned yet) — callers decide how
 * loud to fail (prod rethrows; dev logs + falls back to jose).
 *
 * Download the canonical roots from https://www.apple.com/certificateauthority/
 * AppleRootCA-G3.cer is the ECC root used for StoreKit signing.
 */
export function loadAppleRootCerts(): Buffer[] | null {
  if (loaded) return cache;
  loaded = true;

  const dir = env.APPLE_ROOT_CERTS_DIR;
  if (!dir) {
    log.warn(
      "APPLE_ROOT_CERTS_DIR not set — Apple JWS chain validation disabled",
    );
    cache = null;
    return null;
  }

  let buffers: Buffer[];
  try {
    const files = readdirSync(dir).filter((f) =>
      VALID_EXTENSIONS.includes(extname(f).toLowerCase()),
    );
    if (files.length === 0) {
      log.error("APPLE_ROOT_CERTS_DIR contains no cert files", { dir });
      cache = null;
      return null;
    }
    buffers = files.map((f) => readFileSync(join(dir, f)));
  } catch (err) {
    log.error("failed to load Apple root certs", {
      dir,
      err: err instanceof Error ? err.message : String(err),
    });
    cache = null;
    return null;
  }

  try {
    assertAppleRootFingerprints(buffers);
  } catch (err) {
    log.error("Apple root cert fingerprint mismatch — deployment tampered", {
      dir,
      err: err instanceof Error ? err.message : String(err),
    });
    cache = null;
    throw err;
  }

  log.info("loaded Apple root certs", { dir, count: buffers.length });
  cache = buffers;
  return buffers;
}
