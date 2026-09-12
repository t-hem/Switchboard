import assert from "node:assert/strict";
import test from "node:test";

import { RingBuffer } from "../src/ringbuffer.ts";

const b = (s: string): Buffer => Buffer.from(s, "utf8");

test("rejects a non-positive capacity", () => {
  assert.throws(() => new RingBuffer(0), RangeError);
  assert.throws(() => new RingBuffer(-1), RangeError);
  assert.throws(() => new RingBuffer(1.5), RangeError);
});

test("starts empty", () => {
  const r = new RingBuffer(8);
  assert.equal(r.length, 0);
  assert.equal(r.read().length, 0);
});

test("holds content below capacity verbatim", () => {
  const r = new RingBuffer(8);
  r.append(b("abc"));
  r.append(b("de"));
  assert.equal(r.length, 5);
  assert.equal(r.read().toString(), "abcde");
});

test("exactly filling the buffer is not treated as empty", () => {
  const r = new RingBuffer(4);
  r.append(b("abcd"));
  assert.equal(r.length, 4);
  assert.equal(r.read().toString(), "abcd");
});

test("filling in two writes that land exactly on the boundary", () => {
  const r = new RingBuffer(4);
  r.append(b("ab"));
  r.append(b("cd"));
  assert.equal(r.length, 4);
  assert.equal(r.read().toString(), "abcd");
});

test("drops the oldest bytes once it wraps", () => {
  const r = new RingBuffer(4);
  r.append(b("abcd"));
  r.append(b("ef"));
  assert.equal(r.length, 4);
  assert.equal(r.read().toString(), "cdef");
});

test("a write spanning the wrap point stays in order", () => {
  const r = new RingBuffer(5);
  r.append(b("abc"));
  r.append(b("defg"));
  assert.equal(r.read().toString(), "cdefg");
});

test("a chunk larger than capacity keeps only its tail", () => {
  const r = new RingBuffer(4);
  r.append(b("0123456789"));
  assert.equal(r.length, 4);
  assert.equal(r.read().toString(), "6789");
});

test("a chunk exactly at capacity replaces the contents", () => {
  const r = new RingBuffer(4);
  r.append(b("abcd"));
  r.append(b("wxyz"));
  assert.equal(r.read().toString(), "wxyz");
});

test("empty appends are no-ops", () => {
  const r = new RingBuffer(4);
  r.append(b("ab"));
  r.append(Buffer.alloc(0));
  assert.equal(r.length, 2);
  assert.equal(r.read().toString(), "ab");
});

test("read returns a copy that later appends do not mutate", () => {
  const r = new RingBuffer(4);
  r.append(b("abcd"));
  const snapshot = r.read();
  r.append(b("efgh"));
  assert.equal(snapshot.toString(), "abcd");
});

test("clear empties without resizing", () => {
  const r = new RingBuffer(4);
  r.append(b("abcdef"));
  r.clear();
  assert.equal(r.length, 0);
  assert.equal(r.read().length, 0);
  r.append(b("xy"));
  assert.equal(r.read().toString(), "xy");
  assert.equal(r.capacity, 4);
});

test("matches a naive reference implementation under random writes", () => {
  const cap = 64;
  const r = new RingBuffer(cap);
  let reference = Buffer.alloc(0);
  let seed = 12345;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 500; i++) {
    const chunk = Buffer.alloc(rand(100), 97 + (i % 26));
    r.append(chunk);
    reference = Buffer.concat([reference, chunk]).subarray(-cap);
    assert.equal(r.read().toString("hex"), reference.toString("hex"), `iteration ${i}`);
  }
});

test("preserves arbitrary binary bytes, including NUL and 0xff", () => {
  const r = new RingBuffer(6);
  r.append(Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x41, 0x07]));
  assert.deepEqual([...r.read()], [0x00, 0xff, 0x1b, 0x5b, 0x41, 0x07]);
});
