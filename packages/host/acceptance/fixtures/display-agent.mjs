process.stdin.setRawMode(true);
process.stdin.resume();
let serial = 0;
function burst() {
  for (let i = 0; i < 150; i++) {
    process.stdout.write(`\x1b[32mHISTORY ${String(serial++).padStart(5, '0')}\x1b[0m café 雪 ${'long text '.repeat(12)} END\r\n`);
  }
  process.stdout.write('READY');
}
burst();
process.on('SIGWINCH', () => process.stdout.write(`\r\nRESIZED ${process.stdout.columns}x${process.stdout.rows}\r\nREADY`));
let pending = '';
let arrows = 0;
process.stdin.on('data', data => {
  pending += data.toString().replace(/\x1b\[[CD]/g, () => { arrows++; return ''; });
  while (pending.includes('\r')) {
    const at = pending.indexOf('\r');
    const command = pending.slice(0, at);
    pending = pending.slice(at + 1);
    if (command === 'burst') { process.stdout.write('\r\n'); burst(); }
    else if (command === 'redraw') { process.stdout.write('\x1b[2J\x1b[H\x1b[3J'); burst(); }
    else process.stdout.write(`\r\nINPUT ${command}\r\nREADY`);
  }
  process.stdout.write(`\rREADY ${pending} ARROWS ${arrows}\x1b[K`);
});
