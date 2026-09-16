import assert from "node:assert/strict";
import test from "node:test";

import { TmuxQueryFilter } from "../src/platform/tmux-queries.ts";

const b = (s: string): Buffer => Buffer.from(s, "latin1");
const feed = (chunks: string[]): string => {
  const filter = new TmuxQueryFilter();
  return chunks.map((c) => filter.push(b(c)).toString("latin1")).join("");
};

test("strips tmux's attach-time queries and keeps everything around them", () => {
  assert.equal(feed(["\x1b[?1049h\x1b[>c\x1b[>qhello\x1b[31mred\x1b[0m"]), "\x1b[?1049hhello\x1b[31mred\x1b[0m");
  assert.equal(feed(["a\x1b[>0cb\x1b[>0qc"]), "abc");
});

test("strips a query split at any byte across chunks", () => {
  const stream = "before\x1b[>c\x1b[>qafter";
  for (let cut = 0; cut <= stream.length; cut++) {
    assert.equal(feed([stream.slice(0, cut), stream.slice(cut)]), "beforeafter", `cut at ${cut}`);
  }
  assert.equal(feed(["x\x1b", "[", ">", "c", "y"]), "xy");
});

test("passes through sequences that only share a prefix with a query", () => {
  const passthrough = ["\x1b[>4;1m", "\x1b[>1u", "\x1b[c", "\x1b[?2004h", "\x1b\x1b[>c"];
  assert.deepEqual(passthrough.map((s) => feed([s])), ["\x1b[>4;1m", "\x1b[>1u", "\x1b[c", "\x1b[?2004h", "\x1b"]);
  // A held partial is released intact once the next chunk rules the query out.
  assert.equal(feed(["one\x1b[>", "4;1mtwo"]), "one\x1b[>4;1mtwo");
});

test("preserves non-UTF-8 bytes untouched", () => {
  const filter = new TmuxQueryFilter();
  const raw = Buffer.from([0xff, 0x1b, 0x5b, 0x3e, 0x63, 0xfe, 0x00]);
  assert.deepEqual([...filter.push(raw)], [0xff, 0xfe, 0x00]);
});
