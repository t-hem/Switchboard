/**
 * Removes the terminal queries a tmux client sends to *its* terminal on attach.
 *
 * `tmux attach-session` asks the outer terminal to identify itself with secondary
 * device attributes (`ESC [ > c`) and XTVERSION (`ESC [ > q`). For an attachment the
 * outer terminal is the daemon's pty, not a browser. Left in the stream, the query is
 * stored in the scrollback ring and replayed to every browser that connects; xterm.js
 * answers it (`ESC [ > 0 ; 276 ; 0 c`) long after tmux stopped expecting a reply, so
 * tmux forwards the answer to the agent as typed input and it appears in the prompt.
 *
 * Nothing is answered in their place. tmux treats a terminal that never replies the
 * same as one whose reply it does not recognise, which xterm.js's is: features come
 * from the `xterm-256color` terminfo either way. Pane programs cannot reach this path —
 * tmux answers their queries itself — so every match here is tmux's own.
 */
const QUERIES = ["\x1b[>c", "\x1b[>0c", "\x1b[>q", "\x1b[>0q"].map((q) => Buffer.from(q, "latin1"));

export class TmuxQueryFilter {
  /** A trailing partial query held back until the next chunk decides it. */
  #pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer {
    const data = this.#pending.length > 0 ? Buffer.concat([this.#pending, chunk]) : chunk;
    this.#pending = Buffer.alloc(0);
    const out: Buffer[] = [];
    let start = 0;
    let i = data.indexOf(0x1b);
    while (i !== -1) {
      const rest = data.subarray(i);
      const full = QUERIES.find((q) => rest.length >= q.length && rest.subarray(0, q.length).equals(q));
      if (full) {
        out.push(data.subarray(start, i));
        start = i + full.length;
        i = data.indexOf(0x1b, start);
        continue;
      }
      if (QUERIES.some((q) => rest.length < q.length && q.subarray(0, rest.length).equals(rest))) {
        // Only the tail can be a partial match; hold it for the next chunk.
        out.push(data.subarray(start, i));
        this.#pending = Buffer.from(rest);
        return Buffer.concat(out);
      }
      i = data.indexOf(0x1b, i + 1);
    }
    if (start === 0) return data;
    out.push(data.subarray(start));
    return Buffer.concat(out);
  }
}
