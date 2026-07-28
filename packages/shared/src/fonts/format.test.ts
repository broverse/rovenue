import { describe, it, expect } from "vitest";
import { detectFontFormat } from "./format";

describe("detectFontFormat", () => {
  it("detects OTF from its OTTO signature", () => {
    expect(detectFontFormat(new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0x00]))).toBe("otf");
  });

  it("detects TTF from both of its signatures", () => {
    expect(detectFontFormat(new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]))).toBe("ttf");
    expect(detectFontFormat(new Uint8Array([0x74, 0x72, 0x75, 0x65, 0x00]))).toBe("ttf"); // "true"
  });

  it("detects WOFF2 from its wOF2 signature", () => {
    expect(detectFontFormat(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00]))).toBe("woff2");
  });

  it("rejects WOFF1, which the platforms cannot all load", () => {
    expect(detectFontFormat(new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0x00]))).toBeNull(); // "wOFF"
  });

  it("rejects a file too short to carry a signature", () => {
    expect(detectFontFormat(new Uint8Array([0x4f, 0x54]))).toBeNull();
  });

  it("rejects arbitrary content", () => {
    expect(detectFontFormat(new TextEncoder().encode("<html>"))).toBeNull();
  });
});
