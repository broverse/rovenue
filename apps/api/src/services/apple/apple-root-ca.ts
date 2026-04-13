import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";

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

  try {
    const files = readdirSync(dir).filter((f) =>
      VALID_EXTENSIONS.includes(extname(f).toLowerCase()),
    );
    if (files.length === 0) {
      log.error("APPLE_ROOT_CERTS_DIR contains no cert files", { dir });
      cache = null;
      return null;
    }
    const buffers = files.map((f) => readFileSync(join(dir, f)));
    log.info("loaded Apple root certs", { dir, count: buffers.length });
    cache = buffers;
    return buffers;
  } catch (err) {
    log.error("failed to load Apple root certs", {
      dir,
      err: err instanceof Error ? err.message : String(err),
    });
    cache = null;
    return null;
  }
}
