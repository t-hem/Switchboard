// Real tmux + host websocket + TerminalView in Chromium, using only disposable resources.
// Run from the repo root: node --import tsx packages/web/acceptance/display.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { buildServer } from '../../host/src/server.ts';
import { SessionManager } from '../../host/src/sessions.ts';
import { ClaimRegistry } from '../../host/src/claim.ts';
import { captureTerminal, TmuxInputModes } from '../../host/src/platform/tmux-display.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = fs.mkdtempSync('/tmp/sw-display-accept-');
const socket = path.join(dir, 'test.sock');
const tmux = (...args) => execFileSync('/usr/bin/tmux', ['-S', socket, ...args], {encoding:'utf8'}).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, host, vite, browser;
try {
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'display', '-x', '100', '-y', '30',
    process.execPath, path.join(root, 'packages/host/acceptance/fixtures/display-agent.mjs'));
  tmux('set-option', '-g', 'status', 'off');
  child = pty.spawn('/usr/bin/tmux', ['-S', socket, '-N', 'attach-session', '-t', 'display'], {
    name:'xterm-256color', cols:100, rows:30, env:{PATH:'/usr/bin:/bin',TERM:'xterm-256color',LANG:'C.UTF-8'},
  });
  const record = {id:'display',agent:'test',label:'Display',cwd:dir,pid:child.pid,status:'running',exitCode:null,
    cols:100,rows:30,createdAt:Date.now(),lastOutputAt:Date.now(),backend:'tmux'};
  // The modes the pane announced, attached the way production's linux-tmux
  // attaches them to each frame — the drag bridge is gated on them, so the
  // harness must supply them or the mouse path is never exercised.
  const inputModes = new TmuxInputModes();
  const handle = {pid:child.pid, onData:cb => child.onData(data => { inputModes.feed(Buffer.from(data)); cb(Buffer.from(data)); }), onExit:() => {},
    write:data => child.write(data), resize:(cols,rows) => child.resize(cols,rows),
    snapshot:async () => ({...await captureTerminal(socket, 'display'), bracketedPaste: inputModes.bracketedPaste,
      mouseModes: [...inputModes.mouseModes], clipboard: inputModes.clipboard() ?? undefined}), signal:() => {}, disconnect:() => {}};
  const config = {token:'display-test',hostLabel:'test',scrollbackBytes:262144};
  const registry = {list:() => [{name:'test',available:true}]};
  const sessions = new SessionManager(config, registry, {}, {
    name:'tmux',persistent:true,recover:() => [{session:record,handle}],
  });
  host = await buildServer({hostConfig:config,registry,sessions,ledger:{},claims:new ClaimRegistry(),version:'test'});
  const address = await host.listen({host:'127.0.0.1',port:0});
  vite = await createServer({root:path.join(root,'packages/web'),server:{host:'127.0.0.1',port:0}});
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/acceptance/fixtures/display.html?host=${encodeURIComponent(address)}`;
  browser = await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const screen = () => page.$eval('.xterm-rows', el => el.innerText);
  const scroll = () => page.$eval('.xterm-viewport', el => ({top:el.scrollTop,max:el.scrollHeight-el.clientHeight}));
  const ready = async () => {
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('READY'));
    await page.waitForSelector('[data-testid="terminal-scrollbar-thumb"]');
  };
  await page.setViewport({width:1280,height:800});
  await page.goto(url);
  await ready();
  assert.ok((await scroll()).max > 1000, 'tmux history reaches browser');
  assert.equal(await page.$$eval('[data-testid="terminal-scrollbar-thumb"]', els => els.length),1);
  assert.equal(await page.$eval('.xterm-viewport', el => getComputedStyle(el).scrollbarWidth),'none',
    'native scrollbar is hidden while the custom drag handle remains');
  console.log('PASS desktop has retained history and scrollbar');
  await page.mouse.move(500,300);
  await page.mouse.wheel({deltaY:-900});
  await pause(250);
  assert.ok((await scroll()).top < (await scroll()).max, 'wheel scrolls history');
  const reading = await screen();
  child.write('burst\r');
  await pause(750);
  assert.ok(await screen() === reading, 'streaming does not replace text being read');
  child.write('redraw\r');
  await pause(750);
  assert.ok(await screen() === reading, 'Pi-style rebuild does not replace text being read');
  console.log('PASS wheel scrolling and stable reading during output and history rebuild');
  await page.click('[aria-label="Jump to latest output"]');
  await ready();
  await pause(250);
  assert.ok((await screen()).includes('00449'), 'Latest adopts the newest history');
  await page.click('.xterm-screen');
  await page.keyboard.type('keyboard works');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('INPUT keyboard works'));
  console.log('PASS latest output and keyboard input');
  const latencies = [];
  const measureKey = async (key, expected) => {
    await page.evaluate(expected => {
      window.displayLatency = new Promise(resolve => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (document.querySelector('.xterm-rows')?.textContent.includes(expected)) {
            observer.disconnect(); resolve(performance.now()-start);
          }
        });
        observer.observe(document.querySelector('.xterm-rows'),{subtree:true,childList:true,characterData:true});
      });
    }, expected);
    await page.keyboard.press(key);
    const latency = await Promise.race([page.evaluate(() => window.displayLatency),pause(3000).then(() => {throw Error('input echo timeout');})]);
    latencies.push(latency);
  };
  let typed = '';
  for (const letter of 'responsiveness') {
    typed += letter;
    await measureKey(letter,`READY ${typed} ARROWS 0`);
  }
  await measureKey('ArrowLeft',`READY ${typed} ARROWS 1`);
  await measureKey('ArrowRight',`READY ${typed} ARROWS 2`);
  const sorted = [...latencies].sort((a,b) => a-b);
  const median = sorted[Math.floor(sorted.length/2)];
  assert.ok(median < 90, `typing should bypass 100ms batching, median ${median.toFixed(1)}ms`);
  await page.keyboard.type('0123456789',{delay:15});
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('READY responsiveness0123456789 ARROWS 2'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('INPUT responsiveness0123456789'));
  console.log(`PASS key-to-visible-echo median ${median.toFixed(1)}ms, max ${Math.max(...latencies).toFixed(1)}ms; arrows and rapid typing intact`);
  await page.setViewport({width:390,height:780,isMobile:true,hasTouch:true,deviceScaleFactor:2});
  await page.reload();
  await ready();
  await pause(300);
  const mobile = await scroll();
  assert.ok(mobile.max > 1000, 'mobile reconnect restores history');
  await page.$eval('.xterm-viewport', el => {el.scrollTop=0;});
  await pause(200);
  const mobileText = (await screen()).replace(/\s/g,'');
  assert.ok(mobileText.includes('HISTORY00300'), 'old history is restored');
  assert.ok(mobileText.includes('END'), 'desktop line endings wrap into mobile history');
  console.log('PASS desktop-to-phone replay retains and wraps old lines');
  await page.click('[aria-label="Jump to latest output"]');
  await pause(200);
  const cdp = await page.createCDPSession();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:180,y:220}]});
  for (let y=240; y<=500; y+=20) {
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:180,y}]});
    await pause(20);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await pause(300);
  assert.ok((await scroll()).top < (await scroll()).max-100, 'touch scrolls retained history');
  const thumb = await page.$('[data-testid="terminal-scrollbar-thumb"]');
  const box = await thumb.boundingBox();
  const beforeDrag = (await scroll()).top;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down(); await page.mouse.move(box.x+box.width/2,box.y-120,{steps:10}); await page.mouse.up();
  assert.ok((await scroll()).top < beforeDrag, 'drag scrollbar moves history');

  // The phone's drag bridge, end to end: a TUI on the alternate screen with
  // SGR mouse reporting has no client-side scroll range, so a touch drag must
  // arrive as synthesized SGR wheel notches. And the gesture has to be
  // cancelled from the first touchmove — before a full row of travel — because
  // iOS Safari claims any touch whose first move it sees go uncancelled and
  // then delivers nothing further (found 2026-10-11, handset report; desktop
  // Chromium delivers every move either way, which is why this passed before).
  // Back to the live view first: the scrollbar drag above left the viewport
  // scrolled up, and a scrolled-up reader is not repainted — the TUI frame
  // would never reach the screen.
  await page.click('[aria-label="Jump to latest output"]');
  await pause(250);
  child.write('tui\r');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('TUI READY'));
  await pause(500);
  // A synthetic drag, so the first move's cancellation can be read back —
  // CDP-dispatched touches cannot report defaultPrevented. The first move is
  // deliberately sub-row: it must already be cancelled, before any notch.
  const dragTouches = moves => page.evaluate(moves => {
    const viewport = document.querySelector('.xterm-viewport');
    const fire = (type, y) => {
      const t = new Touch({identifier:1, target:viewport, clientX:180, clientY:y, radiusX:2, radiusY:2, rotationAngle:0, force:1});
      const e = new TouchEvent(type, {cancelable:true, touches:[t], targetTouches:[t], changedTouches:[t]});
      viewport.dispatchEvent(e);
      return e;
    };
    fire('touchstart', moves.fromY);
    const first = fire('touchmove', moves.fromY + (moves.toY < moves.fromY ? -2 : 2));
    const step = moves.toY < moves.fromY ? -6 : 6;
    for (let y = moves.fromY + step; step < 0 ? y >= moves.toY : y <= moves.toY; y += step) fire('touchmove', y);
    viewport.dispatchEvent(new TouchEvent('touchend', {cancelable:true, touches:[], targetTouches:[], changedTouches:[]}));
    return first.defaultPrevented;
  }, moves);
  const firstCancelled = await dragTouches({fromY:400, toY:240});
  assert.ok(firstCancelled, 'a drag in a mouse-mode TUI cancels its first touchmove (iOS delivers moves only then)');
  await page.waitForFunction(() => /WHEEL (\d+) down/.test(document.querySelector('.xterm-rows')?.textContent ?? '') && Number(RegExp.$1) >= 5,
    {timeout:5000, message:'drag up reaches the pane as wheel-down notches'});
  await dragTouches({fromY:240, toY:400});
  await page.waitForFunction(() => /WHEEL (\d+) up/.test(document.querySelector('.xterm-rows')?.textContent ?? '') && Number(RegExp.$1) >= 10,
    {timeout:5000, message:'drag back down reaches the pane as wheel-up notches'});
  console.log('PASS touch drag scrolls a mouse-mode TUI, first move cancelled');
  assert.deepEqual(errors, []);
  console.log('PASS touch scrolling, draggable scrollbar, no browser exceptions');
} finally {
  await browser?.close();
  await vite?.close();
  await host?.close();
  child?.kill();
  try {tmux('kill-server');} catch {}
}
