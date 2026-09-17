import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { TmuxInputModes } from "../src/platform/tmux-display.ts";
import { TerminalSnapshots, type TerminalSnapshot } from "../../web/src/hooks/terminalSnapshots.ts";

test("attachment paste mode survives every possible chunk boundary", () => {
  const sequence = "text\x1b[?1;2004h";
  for (let split = 0; split <= sequence.length; split++) {
    const modes = new TmuxInputModes();
    modes.feed(Buffer.from(sequence.slice(0, split)));
    modes.feed(Buffer.from(sequence.slice(split)));
    assert.equal(modes.bracketedPaste, true);
    modes.feed(Buffer.from("\x1b[?2004l"));
    assert.equal(modes.bracketedPaste, false);
  }
});

test("snapshot rendering retains history, geometry, colors and application cursor keys", async () => {
  const term = new xterm.Terminal({cols:40,rows:5,scrollback:50000,allowProposedApi:true});
  // The browser selection API does not exist on headless xterm.
  Object.assign(term, {hasSelection:() => false, clearSelection:() => {}});
  let painted!: () => void;
  const renderer = new TerminalSnapshots(term as never, () => painted());
  const frame: TerminalSnapshot = {type:"snapshot",cols:40,rows:5,
    history:Array.from({length:60},(_,i) => `line ${i}\n`).join(""),
    screen:"\x1b[31mred\x1b[0m\nline two\n\n\nprompt",
    cursorX:6,cursorY:4,cursorVisible:true,applicationCursor:true,
    bracketedPaste:true,applicationKeypad:false,alternateScreen:false};
  try {
    await new Promise<void>(resolve => {painted=resolve; renderer.receive(frame);});
    assert.equal(term.buffer.active.type,"normal");
    assert.equal(term.buffer.active.baseY,60);
    assert.equal(term.buffer.active.cursorX,6);
    assert.equal(term.buffer.active.cursorY,4);
    assert.equal(term.buffer.active.getLine(60)!.getCell(0)!.getFgColor(),1);
    assert.equal(term.modes.applicationCursorKeysMode,true);
    assert.equal(term.modes.bracketedPasteMode,true);
    const historyMarker = term.registerMarker(-54)!;
    const edited = {...frame,screen:frame.screen.replace("prompt","edited")};
    await new Promise<void>(resolve => {painted=resolve; renderer.receive(edited);});
    assert.equal(historyMarker.isDisposed,false,"screen edit must not discard marked history");
    assert.equal(historyMarker.line,10);
    assert.equal(term.buffer.active.getLine(64)!.translateToString(true),"edited");
    const screenMarker = term.registerMarker(0)!;
    await new Promise<void>(resolve => {painted=resolve; renderer.receive({...edited,cursorX:2});});
    assert.equal(screenMarker.isDisposed,false,"cursor movement must preserve marked output");
    assert.equal(term.buffer.active.getLine(64)!.translateToString(true),"edited");
    assert.equal(term.buffer.active.cursorX,2);
    assert.equal(term.buffer.active.baseY,60);
    term.scrollToLine(10);
    // No renderer.scrolled() call: emulate the native scroll notification gap.
    renderer.receive({...frame,history:"replacement\n"});
    await new Promise(resolve => setTimeout(resolve,30));
    assert.equal(term.buffer.active.viewportY,10);
    assert.equal(term.buffer.active.getLine(10)!.translateToString(true),"line 10");
    await new Promise<void>(resolve => {painted=resolve; renderer.latest();});
    assert.equal(term.buffer.active.baseY,1);
    assert.equal(term.buffer.active.getLine(0)!.translateToString(true),"replacement");
    await new Promise<void>(resolve => {painted=resolve; renderer.receive({...frame,history:"",alternateScreen:true});});
    assert.equal(term.buffer.active.type,"alternate");
    assert.equal(term.buffer.active.baseY,0);
  } finally {renderer.dispose();term.dispose();}
});
