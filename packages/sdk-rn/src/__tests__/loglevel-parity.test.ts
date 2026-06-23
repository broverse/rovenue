import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CANONICAL = ["off", "error", "warn", "info", "debug", "trace"];

describe("LogLevel value parity across core + façades", () => {
  it("UDL enum LogLevel contains exactly the six canonical values", () => {
    const udl = readFileSync(
      join(__dirname, "../../../core-rs/src/librovenue.udl"),
      "utf8",
    );
    const block = udl.match(/enum LogLevel \{([\s\S]*?)\};/)![1];
    const udlValues = [...block.matchAll(/"([A-Za-z]+)"/g)]
      .map((m) => m[1].toLowerCase())
      .sort();
    expect(udlValues).toEqual(
      [...CANONICAL].sort(),
      "UDL LogLevel drifted from canonical set",
    );
  });

  it("RN configure.ts logLevel union covers exactly the six canonical values", () => {
    const src = readFileSync(
      join(__dirname, "../api/configure.ts"),
      "utf8",
    );
    // Extract the union literal types from the logLevel? field:
    //   logLevel?: "off" | "error" | "warn" | "info" | "debug" | "trace";
    const lineMatch = src.match(/logLevel\?:\s*([^;]+);/);
    expect(lineMatch).not.toBeNull(
      "configure.ts: could not find logLevel? field",
    );
    const unionStr = lineMatch![1];
    const rnValues = [...unionStr.matchAll(/"([a-z]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(rnValues).toEqual(
      [...CANONICAL].sort(),
      "RN configure.ts logLevel union drifted from canonical set",
    );
  });

  it("Swift LogSinkBridge maps all six levels and has no default/unknown-default fall-through", () => {
    const src = readFileSync(
      join(
        __dirname,
        "../../../sdk-swift/Sources/Rovenue/Internal/LogSinkBridge.swift",
      ),
      "utf8",
    );
    // Each level appears as a case arm: `case .off:`, `case .error:`, etc.
    for (const level of CANONICAL) {
      expect(src).toContain(
        `case .${level}`,
        `Swift LogSinkBridge: missing case for level "${level}"`,
      );
    }
    expect(src).not.toContain(
      "default:",
      "Swift LogSinkBridge: unexpected default: fall-through found",
    );
    expect(src).not.toContain(
      "@unknown default",
      "Swift LogSinkBridge: unexpected @unknown default fall-through found",
    );
  });

  it("Kotlin LogSinkBridge maps all six levels and has no else -> branch", () => {
    const src = readFileSync(
      join(
        __dirname,
        "../../../sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt",
      ),
      "utf8",
    );
    // Each level appears as: LogLevel.OFF, LogLevel.ERROR, etc.
    for (const level of CANONICAL) {
      const variant = `LogLevel.${level.toUpperCase()}`;
      expect(src).toContain(
        variant,
        `Kotlin LogSinkBridge: missing branch for ${variant}`,
      );
    }
    // The when over record.level must not have an else branch.
    // Isolate only the LogSinkBridge onLog block to avoid false positives
    // elsewhere in the file.
    const bridgeBlock = src.match(
      /internal class LogSinkBridge[\s\S]*?^}/m,
    )?.[0] ?? src;
    expect(bridgeBlock).not.toContain(
      "else ->",
      "Kotlin LogSinkBridge: unexpected else -> branch in level when expression",
    );
  });
});
