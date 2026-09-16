// Disposable HTTP/PTY attachment used only by tmux-spike.mjs, never production.
import fs from 'node:fs';
import http from 'node:http';
import * as pty from 'node-pty';
const [socket, target, readyFile] = process.argv.slice(2);
const child = pty.spawn('/usr/bin/tmux', ['-S', socket, '-N', 'attach-session', '-t', target], {
  name: 'xterm-256color', cols: 80, rows: 24, encoding: null,
  env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8' },
});
let output = Buffer.alloc(0);
child.onData(data => { output = Buffer.concat([output, Buffer.from(data)]).subarray(-262144); });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/input') child.write(url.searchParams.get('data') ?? '');
  if (url.pathname === '/resize') child.resize(Number(url.searchParams.get('cols')), Number(url.searchParams.get('rows')));
  res.end(output);
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(readyFile, String(server.address().port)));
process.on('SIGTERM', () => {
  child.kill('SIGTERM'); // kill the attachment, not the pane
  server.close(() => process.exit(0));
});
