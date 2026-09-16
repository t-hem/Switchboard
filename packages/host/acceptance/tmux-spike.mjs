// Linux-only, isolated real systemd services. No live config, daemon or user tmux touched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';

assert.equal(process.platform, 'linux');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tmux-spike-'));
const socket = path.join(dir, 'owner.sock');
const prefix = `sw-spike-${process.pid}`;
const owner = `${prefix}-owner`;
const daemon = `${prefix}-daemon`;
const here = path.dirname(fileURLToPath(import.meta.url));
const ready = path.join(dir, 'ready');
const config = path.join(dir, 'tmux.conf');
fs.writeFileSync(config, 'set -g exit-empty off\nset -g status off\nset -g prefix None\nset -g prefix2 None\nset -g update-environment ""\nset -g history-limit 2000\nset -g remain-on-exit on\n');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
const tmux = (...args) => run('/usr/bin/tmux', ['-S', socket, '-N', ...args]).trim();
const ctl = (...args) => run('systemctl', ['--user', ...args]);
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await pause(80); }
  throw new Error(`Timeout: ${message}`);
}
function startUnit(name, command) {
  run('systemd-run', ['--user', `--unit=${name}`, '--property=Type=exec', '--property=RemainAfterExit=yes', '--property=KillMode=mixed', '--property=TimeoutStopSec=3', '--', ...command]);
}
function identity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
let port;
async function connected() {
  await until(async () => {
    port = Number(fs.readFileSync(ready, 'utf8'));
    return (await fetch(`http://127.0.0.1:${port}`)).ok;
  }, 'attachment HTTP ready');
}
async function request(route = '') {
  return Buffer.from(await (await fetch(`http://127.0.0.1:${port}/${route}`)).arrayBuffer());
}
async function screen(bytes) {
  const terminal = new xterm.Terminal({ cols: 93, rows: 31, allowProposedApi: true });
  await new Promise(resolve => terminal.write(bytes, resolve));
  const lines = Array.from({length: terminal.buffer.active.length}, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true)).join('\n');
  terminal.dispose();
  return lines;
}
try {
  console.log(run('/usr/bin/tmux', ['-V']).trim());
  startUnit(owner, ['/usr/bin/tmux', '-D', '-S', socket, '-f', config]);
  await until(() => fs.existsSync(socket), 'owner socket');
  const literal = 'spaces ; $(not-a-command) `literal`';
  // Multiple command arguments bypass tmux's shell-command string parsing.
  tmux('new-session', '-d', '-s', 'spike', '-x', '80', '-y', '24',
    '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'TERM=xterm-256color', 'SW_SPIKE=per-session',
    process.execPath, path.join(here, 'fixtures/tmux-agent.mjs'), literal);
  const pid = Number(tmux('display-message', '-p', '-t', 'spike', '#{pane_pid}'));
  const born = identity(pid);
  startUnit(daemon, [process.execPath, path.join(here, 'fixtures/tmux-client.mjs'), socket, 'spike', ready]);
  await connected();
  await until(async () => (await request()).includes(Buffer.from('READY')), 'initial redraw');
  const first = (await request()).toString();
  assert.ok(first.includes('café') && first.includes('雪'));
  assert.ok(first.includes('per-session') && first.includes('not-a-command'));
  await request('resize?cols=93&rows=31');
  await until(() => tmux('display-message', '-p', '-t', 'spike', '#{pane_width}x#{pane_height}') === '93x31', 'resize');
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    fs.unlinkSync(ready);
    if (signal === 'SIGKILL') ctl('kill', '--kill-who=main', '--signal=SIGKILL', daemon);
    else ctl('kill', '--kill-who=main', '--signal=SIGTERM', daemon);
    await pause(650); // agent writes while attachment is absent
    assert.equal(identity(pid), born);
    ctl('restart', daemon);
    await connected();
    await request(`input?data=${encodeURIComponent('marker\x02\x03')}`);
    await until(async () => (await request()).toString().includes('CTRL-C'), `${signal} input after reconnect`);
    assert.equal(identity(pid), born);
    console.log(`PASS ${signal}: same pane PID/start identity and working input`);
  }
  assert.ok((await screen(await request())).includes('tick'), 'rendered alternate screen restored');
  assert.ok(tmux('capture-pane', '-p', '-t', 'spike').includes('tick'));
  // Prefix is disabled: Ctrl-B reaches the agent rather than opening a tmux command.
  await request(`input?data=${encodeURIComponent('\x02')}`);
  await until(async () => (await request()).toString().includes('u0002'), 'literal Ctrl-B');
  ctl('stop', daemon);
  tmux('send-keys', '-t', 'spike', 'q');
  await until(() => tmux('display-message', '-p', '-t', 'spike', '#{pane_dead}:#{pane_dead_status}') === '1:23', 'retained real exit status');
  // Negative case: stopping the owner really kills an owned live workload.
  tmux('new-session', '-d', '-s', 'negative', '/bin/sleep', '120');
  const negativePid = Number(tmux('display-message', '-p', '-t', 'negative', '#{pane_pid}'));
  ctl('stop', owner);
  await until(() => !fs.existsSync(`/proc/${negativePid}`), 'owner stop terminates workload');
  console.log('PASS retained exit 23, rendered replay, argv/env, Unicode, resize, Ctrl-C/Ctrl-B, owner failure');
  console.log('No raw output history persisted. tmux attachment is rendered terminal output, not original byte replay.');
} finally {
  for (const unit of [daemon, owner]) { try { ctl('stop', unit); } catch {} try { ctl('reset-failed', unit); } catch {} }
  fs.rmSync(dir, {recursive: true, force: true});
}
