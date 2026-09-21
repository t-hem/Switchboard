// Repro for the "a card briefly becomes a giant block of highlight" flash.
//
// Resizing a Pi session makes Pi repaint, and for roughly 9-24ms the pane content
// itself contains rows whose card background covers the full terminal width (four rows
// at 100% against a steady state of none). Because that is in the pane grid tmux holds,
// every client shows it - a plain terminal and Switchboard alike - so this measures the
// content side and says nothing about Switchboard's paint path.
//
// Observed for both pi's own green tool cards (48;5;22) and the pi-ask-user overlay
// (48;5;17), so it is pi's rendering rather than any one extension.
//
// The sampler runs as fast as tmux answers, because the transient survives only
// milliseconds; a probe that waits even 100ms after the resize sees nothing.
//
// Run from the repo root: node --import tsx packages/web/acceptance/resize-flash.mjs
import { execFileSync } from 'node:child_process';
import * as pty from 'node-pty';
import fs from 'node:fs';
const dir = fs.mkdtempSync('/tmp/bgcheck-');
const socket = dir + '/t.sock';
const tmux = (...a) => execFileSync('/usr/bin/tmux', ['-S', socket, ...a], { encoding: 'utf8' }).trim();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const home = process.env.HOME;
const env = { ...process.env, PATH: `${home}/.local/bin:/usr/bin:/bin`, HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8' };
const PROMPT = process.env.PROMPT ?? 'Run bash: seq 1 5. Then stop.';
const READY = new RegExp(process.env.READY ?? 'seq|bash');

// Per line: which background colours it uses and how much of the row they cover.
function lines(raw) {
  return raw.split('\n').map((line) => {
    let bg = null, covered = 0, cells = 0;
    const colours = new Set();
    let i = 0;
    while (i < line.length) {
      if (line[i] === '\x1b') {
        const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
        if (m) {
          for (const p of m[1].split(';')) {
            const n = Number(p);
            if (p === '' || n === 0) bg = null;
            else if (n === 7) bg = 'reverse';
            else if (n === 27 || n === 49) bg = null;
            else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = `${n}`;
            else if (n === 48) bg = '48';
            else if (bg === '48' && p !== '5') bg = `48;5;${p}`;
          }
          i += m[0].length; continue;
        }
        const other = /^\x1b\][^\x07]*\x07|^\x1b\[[0-9;]*[a-zA-Z]/.exec(line.slice(i));
        i += other ? other[0].length : 1; continue;
      }
      cells++;
      if (bg !== null) { covered++; colours.add(bg); }
      i++;
    }
    return { cells, covered, share: cells ? covered / cells : 0, colours: [...colours] };
  }).filter((l) => l.cells > 0);
}
const sample = () => {
  const ls = lines(tmux('capture-pane', '-p', '-e', '-t', 'd'));
  const full = ls.filter((l) => l.share >= 0.95).length;
  const byColour = new Map();
  for (const l of ls) for (const c of l.colours) {
    const rec = byColour.get(c) ?? { lines: 0, maxShare: 0 };
    rec.lines++; rec.maxShare = Math.max(rec.maxShare, l.share);
    byColour.set(c, rec);
  }
  return { full, byColour };
};
const fmt = (s) => [...s.byColour.entries()].map(([c, r]) => `${c}:${r.lines}lines/${(r.maxShare*100).toFixed(0)}%`).join('  ') + `  fullRows=${s.full}`;

execFileSync('/usr/bin/tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'd', '-x', '120', '-y', '40', `${home}/.local/bin/pi`], { env });
tmux('set-option', '-g', 'status', 'off');
const child = pty.spawn('/usr/bin/tmux', ['-S', socket, '-N', 'attach-session', '-t', 'd'], { name: 'xterm-256color', cols: 120, rows: 40, env });
try {
  await pause(4000);
  tmux('send-keys', '-t', 'd', '-l', PROMPT);
  tmux('send-keys', '-t', 'd', 'Enter');
  let last = '';
  for (let i = 0; i < 70; i++) { await pause(1000); const now = tmux('capture-pane', '-p', '-t', 'd'); if (now === last && READY.test(now)) break; last = now; }
  console.log(`PROMPT: ${PROMPT}`);
  console.log(`steady   ${fmt(sample())}`);
  for (const width of [90, 70]) {
    child.resize(width, 40);
    const samples = [];
    const until = Date.now() + 2000;
    while (Date.now() < until) samples.push({ at: Date.now(), s: sample() });
    const peak = samples.reduce((a, b) => (b.s.full > a.s.full ? b : a), samples[0]);
    console.log(`\nresize ${width}: ${samples.length} pane captures in 2s`);
    console.log(`  peak full-width background rows: ${peak.s.full}   ${fmt(peak.s)}`);
    let prev = null;
    for (const s of samples) {
      const key = `${s.s.full}|${fmt(s.s)}`;
      if (key !== prev) { console.log(`    t+${String(s.at - samples[0].at).padStart(4)}ms  ${fmt(s.s)}`); prev = key; }
      if (s.at > samples[0].at + 400) break;
    }
  }
} finally { child.kill(); try { tmux('kill-server'); } catch {} }
