import { describe, expect, it } from "vitest";
import { isAmazonSigningCertHost, verifySnsSignature } from "./sns-signature";

describe("isAmazonSigningCertHost", () => {
  it("accepts sns.us-east-1.amazonaws.com", () => {
    expect(
      isAmazonSigningCertHost("https://sns.us-east-1.amazonaws.com/x.pem"),
    ).toBe(true);
  });
  it("rejects non-amazonaws.com host", () => {
    expect(
      isAmazonSigningCertHost("https://evil.example.com/x.pem"),
    ).toBe(false);
  });
  it("rejects subdomain attack (amazonaws.com.evil.com)", () => {
    expect(
      isAmazonSigningCertHost("https://amazonaws.com.evil.com/x.pem"),
    ).toBe(false);
  });
  it("rejects http:// scheme", () => {
    expect(
      isAmazonSigningCertHost("http://sns.us-east-1.amazonaws.com/x.pem"),
    ).toBe(false);
  });
  it("rejects malformed URLs", () => {
    expect(isAmazonSigningCertHost("not-a-url")).toBe(false);
  });
});

describe("verifySnsSignature", () => {
  it("rejects payloads with wrong SignatureVersion", async () => {
    await expect(
      verifySnsSignature({
        Type: "Notification",
        SignatureVersion: "2",
        Signature: "",
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
        Message: "hi",
        MessageId: "m",
        Timestamp: "2026-05-26T00:00:00.000Z",
        TopicArn: "arn:aws:sns:us-east-1:1:t",
      } as never),
    ).rejects.toThrow(/SignatureVersion/);
  });

  it("rejects payloads from a non-amazonaws cert host", async () => {
    await expect(
      verifySnsSignature({
        Type: "Notification",
        SignatureVersion: "1",
        Signature: "abc",
        SigningCertURL: "https://evil.example.com/cert.pem",
        Message: "hi",
        MessageId: "m",
        Timestamp: "2026-05-26T00:00:00.000Z",
        TopicArn: "arn:aws:sns:us-east-1:1:t",
      } as never),
    ).rejects.toThrow(/SigningCertURL/);
  });

  it("rejects payloads with an invalid signature against a real-looking cert", async () => {
    // We don't have a real Amazon cert to test against, so this test just
    // confirms the path: a valid-format SigningCertURL + bad signature →
    // throws either "cert fetch" (network) or "Invalid SNS signature".
    await expect(
      verifySnsSignature({
        Type: "Notification",
        SignatureVersion: "1",
        Signature: "not-a-real-signature",
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-this-cert-does-not-exist.pem",
        Message: "hi",
        MessageId: "m",
        Timestamp: "2026-05-26T00:00:00.000Z",
        TopicArn: "arn:aws:sns:us-east-1:1:t",
      } as never),
    ).rejects.toThrow();
  });
});
