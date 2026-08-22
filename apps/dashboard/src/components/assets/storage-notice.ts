import {
  ASSET_STORAGE_CRITICAL_RATIO,
  ASSET_STORAGE_WARN_RATIO,
} from "@rovenue/shared";
import type { StorageUsage } from "../../lib/hooks/useAssets";

// =============================================================
// How close is this project to its storage cap?
// =============================================================
//
// Pure, so the thresholds can be tested without rendering: the ratios
// themselves live in @rovenue/shared next to the caps they apply to.
//
// `full` is deliberately `used >= limit`, not `used > limit`: the
// server's reservation refuses anything that would take the total PAST
// the cap, so a project sitting exactly on it can no longer upload a
// single byte. Reporting that as "not full yet" would leave the author
// pressing an upload button that can only fail.

export type StorageNotice = "none" | "warning" | "critical" | "full";

export function storageNoticeFor(usage: StorageUsage | undefined): StorageNotice {
  // No usage loaded yet, or an unlimited project (self-host, enterprise):
  // there is no cap to be close to. A zero limit needs no case of its
  // own — nothing fits under it, so the comparison below already calls
  // it full.
  if (!usage || usage.limitBytes === null) return "none";
  if (usage.usedBytes >= usage.limitBytes) return "full";

  const ratio = usage.usedBytes / usage.limitBytes;
  if (ratio >= ASSET_STORAGE_CRITICAL_RATIO) return "critical";
  if (ratio >= ASSET_STORAGE_WARN_RATIO) return "warning";
  return "none";
}
