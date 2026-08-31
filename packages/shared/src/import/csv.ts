// Streaming CSV parser for the data-import tool.
//
// A real RevenueCat/Adapty export is gigabytes. This never buffers the
// whole file and never `split("\n")`s the input: it walks decoded text
// chunk-by-chunk through a small state machine, emitting the header once
// and then one row at a time (with its 1-based source line number) as
// soon as that row is complete. A quoted field — or a multi-byte UTF-8
// character — may straddle a chunk boundary; both are handled by keeping
// decode/parse state across `for await` iterations rather than treating
// each chunk in isolation.
//
// BOM handling: a leading UTF-8 byte-order-mark is stripped by
// `TextDecoder` itself — its default `ignoreBOM: false` already removes
// a leading BOM during `decode()`, before this module ever sees the
// text. There is deliberately no BOM-stripping code here; adding one
// would be dead code shadowing behavior `TextDecoder` already provides
// (see the BOM test in csv.test.ts, which exercises this decoder
// behavior end-to-end rather than an in-module code path).

const COMMA = ",";
const DOUBLE_QUOTE = '"';
const CARRIAGE_RETURN = "\r";
const LINE_FEED = "\n";

/** First source line is line 1; the header occupies it. */
const FIRST_LINE_NUMBER = 1;

type CsvHeaderEvent = { header: string[] };
type CsvRowEvent = { row: string[]; lineNumber: number };
export type CsvEvent = CsvHeaderEvent | CsvRowEvent;

type ParserState = {
  /** Cells completed so far in the row currently being assembled. */
  cells: string[];
  /** Text accumulated for the cell currently being assembled. */
  cell: string;
  /** Whether we are inside an opening/closing pair of double quotes. */
  inQuotes: boolean;
  /** True once any character of the current row has been consumed. */
  rowStarted: boolean;
  /** 1-based number of the source line the row-in-progress starts on. */
  lineNumber: number;
  /** Header row, once seen; rows are validated against its length. */
  header: string[] | undefined;
};

function createParserState(): ParserState {
  return {
    cells: [],
    cell: "",
    inQuotes: false,
    rowStarted: false,
    lineNumber: FIRST_LINE_NUMBER,
    header: undefined,
  };
}

/**
 * Finalizes the row-in-progress (if any characters were seen for it) into
 * a CsvEvent, validating column count against the header once known.
 * Returns undefined for a trailing empty line with nothing accumulated
 * (e.g. the newline that ends the file).
 */
function* finishRow(state: ParserState): Generator<CsvEvent> {
  if (!state.rowStarted) {
    return;
  }
  state.cells.push(state.cell);
  const row = state.cells;
  const completedLineNumber = state.lineNumber;

  state.cells = [];
  state.cell = "";
  state.rowStarted = false;
  state.lineNumber += 1;

  if (!state.header) {
    state.header = row;
    yield { header: state.header };
    return;
  }

  if (row.length !== state.header.length) {
    throw new Error(
      `Row at line ${completedLineNumber} has column count ${row.length}, ` +
        `expected ${state.header.length} (matching the header)`,
    );
  }
  yield { row, lineNumber: completedLineNumber };
}

/**
 * Feeds one decoded text chunk through the state machine, yielding a
 * header event (once) and row events as rows complete. Any partial row
 * remains in `state` for the next chunk (or `flush`).
 */
function* consumeChunk(state: ParserState, text: string): Generator<CsvEvent> {
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];

    if (state.inQuotes) {
      if (ch === DOUBLE_QUOTE) {
        const next = text[i + 1];
        if (next === DOUBLE_QUOTE) {
          state.cell += DOUBLE_QUOTE;
          i += 2;
          continue;
        }
        state.inQuotes = false;
        i += 1;
        continue;
      }
      state.cell += ch;
      state.rowStarted = true;
      i += 1;
      continue;
    }

    if (ch === DOUBLE_QUOTE && state.cell === "") {
      state.inQuotes = true;
      state.rowStarted = true;
      i += 1;
      continue;
    }

    if (ch === COMMA) {
      state.cells.push(state.cell);
      state.cell = "";
      state.rowStarted = true;
      i += 1;
      continue;
    }

    if (ch === CARRIAGE_RETURN) {
      // Swallow bare \r and \r\n alike; the following \n (if any) drives
      // the actual line completion below.
      i += 1;
      continue;
    }

    if (ch === LINE_FEED) {
      yield* finishRow(state);
      i += 1;
      continue;
    }

    state.cell += ch;
    state.rowStarted = true;
    i += 1;
  }
}

/** Emits the final row when the stream ends without a trailing newline. */
function* flush(state: ParserState): Generator<CsvEvent> {
  yield* finishRow(state);
}

/**
 * Parses a CSV byte stream incrementally, yielding a header event once
 * and then a row event per data row, each carrying its 1-based source
 * line number. Decoding uses `TextDecoder` in streaming mode so a
 * multi-byte UTF-8 character split across chunk boundaries decodes
 * correctly; a quoted field split across chunks is likewise preserved by
 * carrying parser state between chunks. Throws if a data row's column
 * count does not match the header.
 */
export async function* parseCsvStream(
  source: AsyncIterable<Uint8Array>,
  opts?: { encoding?: string },
): AsyncGenerator<CsvEvent> {
  const decoder = new TextDecoder(opts?.encoding ?? "utf-8");
  const state = createParserState();

  for await (const chunk of source) {
    const text = decoder.decode(chunk, { stream: true });
    yield* consumeChunk(state, text);
  }
  const finalText = decoder.decode();
  if (finalText.length > 0) {
    yield* consumeChunk(state, finalText);
  }
  yield* flush(state);
}

/**
 * Test/debug helper: drains `parseCsvStream` into arrays. Not for
 * production use on large files — it defeats the whole point of
 * streaming by holding every row in memory at once.
 */
export async function parseCsvToRows(
  source: AsyncIterable<Uint8Array>,
): Promise<{ header: string[]; rows: string[][]; lineNumbers: number[] }> {
  let header: string[] = [];
  const rows: string[][] = [];
  const lineNumbers: number[] = [];

  for await (const event of parseCsvStream(source)) {
    if ("header" in event) {
      header = event.header;
    } else {
      rows.push(event.row);
      lineNumbers.push(event.lineNumber);
    }
  }

  return { header, rows, lineNumbers };
}
