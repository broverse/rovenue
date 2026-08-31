import { describe, expect, it } from "vitest";
import { parseCsvToRows } from "../csv";

const src = (s: string) =>
  (async function* () {
    yield new TextEncoder().encode(s);
  })();

describe("parseCsvStream", () => {
  it("parses a simple header and row", async () => {
    const out = await parseCsvToRows(src("a,b\n1,2\n"));
    expect(out.header).toEqual(["a", "b"]);
    expect(out.rows).toEqual([["1", "2"]]);
  });

  it("strips a UTF-8 BOM from the first header cell", async () => {
    const out = await parseCsvToRows(src("﻿a,b\n1,2\n"));
    expect(out.header).toEqual(["a", "b"]);
  });

  it("honours quoted fields containing commas, newlines and escaped quotes", async () => {
    const out = await parseCsvToRows(src('a,b\n"x,y","he said ""hi""\nsecond line"\n'));
    expect(out.rows).toEqual([["x,y", 'he said "hi"\nsecond line']]);
  });

  it("accepts unquoted values (Adapty's documented style)", async () => {
    const out = await parseCsvToRows(src("user_id,token\nu1,t1\n"));
    expect(out.rows).toEqual([["u1", "t1"]]);
  });

  it("handles CRLF line endings", async () => {
    const out = await parseCsvToRows(src("a,b\r\n1,2\r\n"));
    expect(out.rows).toEqual([["1", "2"]]);
  });

  it("does not split a row that straddles two chunks", async () => {
    const chunked = (async function* () {
      yield new TextEncoder().encode('a,b\n"x');
      yield new TextEncoder().encode(',y",2\n');
    })();
    const out = await parseCsvToRows(chunked);
    expect(out.rows).toEqual([["x,y", "2"]]);
  });

  it("reports the source line number with each row", async () => {
    const out = await parseCsvToRows(src("a\n1\n2\n"));
    expect(out.lineNumbers).toEqual([2, 3]);
  });

  it("rejects a row whose column count differs from the header", async () => {
    await expect(parseCsvToRows(src("a,b\n1\n"))).rejects.toThrow(/column count/i);
  });
});
