import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as pty from 'node-pty';
const dir = fs.mkdtempSync('/tmp/themecheck-');
const socket = dir + '/t.sock';
const tmux = (...a) => execFileSync('/usr/bin/tmux', ['-S', socket, ...a], { encoding: 'utf8' }).trim();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const home = process.env.HOME;
const env = { ...process.env, PATH: `${home}/.local/bin:/usr/bin:/bin`, HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8' };
execFileSync('/usr/bin/tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'd', '-x', '120', '-y', '40', `${home}/.local/bin/pi`, '-nt'], { env });
tmux('set-option', '-g', 'status', 'off');
const child = pty.spawn('/usr/bin/tmux', ['-S', socket, '-N', 'attach-session', '-t', 'd'], { name: 'xterm-256color', cols: 120, rows: 40, env });
const bgIdx = (raw) => { const s=new Set(); for (const m of raw.matchAll(/\x1b\[48;5;(\d+)m/g)) s.add(Number(m[1])); return [...s].sort((a,b)=>a-b); };
try {
  await pause(4000);
  tmux('send-keys', '-t', 'd', '-l', 'Output one fenced python code block of about 25 lines for a layered config loader using tomllib. No prose.');
  tmux('send-keys', '-t', 'd', 'Enter');
  let last='';
  for (let i=0;i<50;i++){ await pause(1000); const now=tmux('capture-pane','-p','-t','d'); if(now===last && /```/.test(now)) break; last=now; }
  const withEsc = tmux('capture-pane','-p','-e','-t','d');
  console.log('streamed:', /def |class /.test(last) ? 'yes' : 'NO');
  console.log('background indices on screen now:', bgIdx(withEsc).join(', ') || '(none)');
  // resize transient: sample as fast as tmux answers, watch for any full-width bg row
  const measure=(line)=>{ let bg=null,covered=0,cells=0,i=0; while(i<line.length){ if(line[i]==='\x1b'){ const m=/^\x1b\[([0-9;]*)m/.exec(line.slice(i)); if(m){ for(const p of m[1].split(';')){const n=Number(p); if(p===''||n===0) bg=null; else if(n===7)bg='r'; else if(n===27||n===49)bg=null; else if((n>=40&&n<=47)||(n>=100&&n<=107)||n===48)bg='bg';} i+=m[0].length;continue;} const o=/^\x1b\][^\x07]*\x07|^\x1b\[[0-9;]*[a-zA-Z]/.exec(line.slice(i)); i+=o?o[0].length:1; continue;} cells++; if(bg)covered++; i++; } return {covered,cells}; };
  for (const width of [90, 70]) {
    child.resize(width,40);
    let worst=0; const until=Date.now()+1500;
    while(Date.now()<until){ const ls=tmux('capture-pane','-p','-e','-t','d').split('\n').map(measure); for(const l of ls){ if(l.cells>10 && l.covered/l.cells>0.7) worst=Math.max(worst,l.covered/l.cells);} }
    console.log(`resize ${width}: max full-width background coverage seen = ${(worst*100).toFixed(0)}%`);
  }
} finally { child.kill(); try{tmux('kill-server')}catch{} }
