// A small actual TUI: alternate screen, raw keys, resize, signal and exact argv/env.
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[HREADY café 雪\r\n');
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), env: process.env.SW_SPIKE }) + '\r\n');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  if (text.includes('q')) process.exit(23);
  if (text.includes('\x03')) process.stdout.write('CTRL-C\r\n');
  else process.stdout.write(`INPUT:${JSON.stringify(text)}\r\n`);
});
process.stdout.on('resize', () => process.stdout.write(`SIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`));
setInterval(() => process.stdout.write('tick\r\n'), 300);
