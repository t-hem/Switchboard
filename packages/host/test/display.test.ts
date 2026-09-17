import assert from "node:assert/strict";
import { test } from "node:test";

import { extractDisplay, oscTitle, stripAnsi, tidyTitle } from "../src/display.js";

const MODEL = "model:\\s*(\\S+)";
const TITLE = "✻\\s*(.+)";

test("no patterns and no title reads nothing", () => {
  assert.deepEqual(extractDisplay("model: opus-5", undefined), {});
  assert.deepEqual(extractDisplay("model: opus-5", {}), {});
});

test("a pattern with no match reads nothing rather than failing", () => {
  assert.deepEqual(extractDisplay("nothing interesting here", { model: MODEL }), {});
});

test("capture group one wins, and the whole match is the fallback", () => {
  assert.deepEqual(extractDisplay("model: opus-5", { model: MODEL }), { model: "opus-5" });
  assert.deepEqual(extractDisplay("model: opus-5", { model: "opus-\\d" }), { model: "opus-5" });
});

test("colour codes around the value do not defeat the pattern", () => {
  const painted = "[1;32mmodel:[0m [36mopus-5[0m";
  assert.equal(stripAnsi(painted), "model: opus-5");
  assert.deepEqual(extractDisplay(painted, { model: MODEL }), { model: "opus-5" });
});

test("an OSC title sequence is stripped, not matched as content", () => {
  assert.equal(stripAnsi("]0;a window titlemodel: haiku-4.5"), "model: haiku-4.5");
});

test("the newest occurrence wins, so a switched model reads as current", () => {
  const text = ["model: sonnet-5", "... work ...", "model: opus-5"].join("\n");
  assert.deepEqual(extractDisplay(text, { model: MODEL }), { model: "opus-5" });
});

test("model and title are found independently", () => {
  const text = ["✻ Tightening the ledger's PID guard", "model: opus-5"].join("\n");
  assert.deepEqual(extractDisplay(text, { model: MODEL, title: TITLE }), {
    model: "opus-5",
    title: "Tightening the ledger's PID guard",
  });
});

test("one unusable pattern does not suppress the other", () => {
  const text = ["✻ Still working", "model: opus-5"].join("\n");
  assert.deepEqual(extractDisplay(text, { model: "(unclosed", title: TITLE }), { title: "Still working" });
});

test("an empty or whitespace-only capture is treated as no match", () => {
  assert.deepEqual(extractDisplay("model:   \n", { model: "model:(.*)" }), {});
});

test("a value is bounded, so a pathological line cannot fill the row", () => {
  const long = `model: ${"x".repeat(5_000)}`;
  const model = extractDisplay(long, { model: MODEL }).model;
  assert.ok(model !== undefined && model.length <= 120);
});

test("only recent lines are considered, so a stale banner scrolls away", () => {
  const text = ["model: opus-5", ...Array.from({ length: 400 }, (_, i) => `line ${i}`)].join("\n");
  assert.deepEqual(extractDisplay(text, { model: MODEL }), {});
});


test("the last title sequence wins, across all three OSC forms", () => {
  assert.equal(oscTitle("\u001B]0;first\u0007 work \u001B]2;second\u0007"), "second");
  assert.equal(oscTitle("\u001B]1;icon name\u001B\\"), "icon name");
  assert.equal(oscTitle("no sequences here"), undefined);
  assert.equal(oscTitle("\u001B]0;\u0007"), undefined);
});

test("a terminal title decorates a session with no patterns at all", () => {
  assert.deepEqual(extractDisplay("", undefined, "Fix responsive display issues"), {
    title: "Fix responsive display issues",
  });
});

test("an animated spinner prefix is dropped so the row does not rewrite itself", () => {
  assert.equal(tidyTitle("◐ Browser usage in Claude Code"), "Browser usage in Claude Code");
  assert.equal(tidyTitle("✳ Claude Code"), "Claude Code");
  // Frames differ; the title the row renders must not.
  const frames = ["◐", "◓", "◑", "◒"].map((g) => extractDisplay("", undefined, `${g} Same task`).title);
  assert.deepEqual(new Set(frames), new Set(["Same task"]));
});

test("a title that is only decoration is kept rather than emptied", () => {
  assert.equal(tidyTitle("◐"), "◐");
});

test("an explicit pattern outranks the terminal title", () => {
  const text = "✻ From the scrollback";
  assert.deepEqual(extractDisplay(text, { title: TITLE }, "From the terminal"), {
    title: "From the scrollback",
  });
  // ...and the terminal title is the fallback when the pattern finds nothing.
  assert.deepEqual(extractDisplay("nothing", { title: TITLE }, "From the terminal"), {
    title: "From the terminal",
  });
});

test("a title sequence in the bytes is the last resort", () => {
  assert.deepEqual(extractDisplay("\u001B]0;From the bytes\u0007", undefined, undefined), {
    title: "From the bytes",
  });
});
