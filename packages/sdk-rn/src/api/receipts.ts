import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { ReceiptResult } from "../types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

export async function postAppleReceipt(jws: string, productId: string): Promise<ReceiptResult> {
  return call(() => getNative().postAppleReceipt(jws, productId));
}

export async function postGoogleReceipt(receipt: string, productId: string): Promise<ReceiptResult> {
  return call(() => getNative().postGoogleReceipt(receipt, productId));
}
