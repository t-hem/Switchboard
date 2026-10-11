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
// SGR wheel reports the client synthesizes for a touch drag: one entry per
// notch, 'down' (button 65) or 'up' (64). Counted on arrival so the acceptance
// can assert the drag reached the pane, from the pane's side of the pty.
let wheels = [];
process.stdin.on('data', data => {
  const text = data.toString();
  for (const match of text.matchAll(/\x1b\[<(6[45]);\d+;\d+M/g)) wheels.push(match[1] === '65' ? 'down' : 'up');
  pending += text.replace(/\x1b\[[CD]/g, () => { arrows++; return ''; }).replace(/\x1b\[<6[45];\d+;\d+M/g, '');
  while (pending.includes('\r')) {
    const at = pending.indexOf('\r');
    const command = pending.slice(0, at);
    pending = pending.slice(at + 1);
    if (command === 'burst') { process.stdout.write('\r\n'); burst(); }
    else if (command === 'redraw') { process.stdout.write('\x1b[2J\x1b[H\x1b[3J'); burst(); }
    // An agent TUI: the alternate screen plus SGR mouse reporting, the state
    // the drag bridge is gated on. The DECSETs travel to the attachment the
    // same way a real agent's do, so the host parses the modes.
    else if (command === 'tui') {
      // Marker on row 1, cursor parked on row 2: the READY echo below always
      // overwrites the cursor row, and the acceptance waits on the marker.
      process.stdout.write('\r\n\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[H\x1b[2J\x1b[1;1HTUI READY\x1b[2;1H');
    }
    else process.stdout.write(`\r\nINPUT ${command}\r\nREADY`);
  }
  process.stdout.write(`\rREADY ${pending} ARROWS ${arrows} WHEEL ${wheels.length}${wheels.length ? ' ' + wheels[wheels.length - 1] : ''}\x1b[K`);
});
