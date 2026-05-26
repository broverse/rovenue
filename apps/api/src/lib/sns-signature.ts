import { createVerify } from "node:crypto";

export interface SnsPayload {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  /** Present on SubscriptionConfirmation / UnsubscribeConfirmation. */
  Token?: string;
  SubscribeURL?: string;
}

// Keys included in the canonical string-to-sign per SNS docs.
const STRING_TO_SIGN_KEYS_NOTIFICATION = [
  "Message",
  "MessageId",
  "Subject",
  "Timestamp",
  "TopicArn",
  "Type",
] as const;

const STRING_TO_SIGN_KEYS_SUBSCRIPTION = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
] as const;

export function isAmazonSigningCertHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return /\.amazonaws\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function canonicalize(p: SnsPayload): string {
  const keys =
    p.Type === "Notification"
      ? STRING_TO_SIGN_KEYS_NOTIFICATION
      : STRING_TO_SIGN_KEYS_SUBSCRIPTION;
  const lines: string[] = [];
  for (const k of keys) {
    const v = (p as unknown as Record<string, string | undefined>)[k];
    if (v == null) continue;
    lines.push(k);
    lines.push(String(v));
  }
  return lines.join("\n") + "\n";
}

async function fetchPem(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cert fetch failed: HTTP ${res.status}`);
  return res.text();
}

export async function verifySnsSignature(p: SnsPayload): Promise<void> {
  if (p.SignatureVersion !== "1") {
    throw new Error(`Unsupported SignatureVersion: ${p.SignatureVersion}`);
  }
  if (!isAmazonSigningCertHost(p.SigningCertURL)) {
    throw new Error(`Untrusted SigningCertURL host: ${p.SigningCertURL}`);
  }
  const pem = await fetchPem(p.SigningCertURL);
  const verifier = createVerify("RSA-SHA1");
  verifier.update(canonicalize(p));
  verifier.end();
  const ok = verifier.verify(pem, p.Signature, "base64");
  if (!ok) throw new Error("Invalid SNS signature");
}
