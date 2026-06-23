import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_KINDS } from "../errors";

describe("ErrorKind parity across façades", () => {
  it("RN ERROR_KINDS matches the UDL ErrorKind enum", () => {
    const udl = readFileSync(join(__dirname, "../../../core-rs/src/librovenue.udl"), "utf8");
    const block = udl.match(/enum ErrorKind \{([\s\S]*?)\};/)![1];
    const udlKinds = [...block.matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]).sort();
    expect([...ERROR_KINDS].sort()).toEqual(udlKinds);
  });
});
