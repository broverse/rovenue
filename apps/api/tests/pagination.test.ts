import { describe, expect, test } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  type Cursor,
} from "../src/lib/pagination";

describe("pagination cursor", () => {
  test("round-trips a cursor", () => {
    const input: Cursor = {
      createdAt: new Date("2026-04-18T10:00:00.000Z"),
      id: "abc123",
    };
    const encoded = encodeCursor(input);
    expect(typeof encoded).toBe("string");
    const decoded = decodeCursor(encoded);
    expect(decoded?.createdAt.toISOString()).toBe(input.createdAt.toISOString());
    expect(decoded?.id).toBe(input.id);
  });

  test("returns null for undefined / empty input", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  test("returns null for malformed base64", () => {
    expect(decodeCursor("not-base64!!!")).toBeNull();
  });

  test("returns null for JSON that doesn't match the shape", () => {
    const bad = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  test("returns null for invalid date", () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "x" }),
    ).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });
});
