/**
 * A fixed-size byte ring buffer holding the most recent N bytes of PTY output.
 *
 * Replayed to a client in one chunk on attach, which is what makes "open the laptop
 * and hit refresh" work. Never written to disk.
 *
 * Bytes, not strings: PTY output is forwarded verbatim, so the buffer must not
 * re-encode it. The cost is that the oldest retained bytes can begin mid-UTF-8-
 * sequence or mid-escape-sequence after the buffer wraps; terminals resynchronise on
 * the next valid sequence, so this shows up as at most a garbled first character.
 */
export class RingBuffer {
  readonly #buf: Buffer;
  #pos = 0;
  #filled = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`ring buffer capacity must be a positive integer, got ${capacity}`);
    }
    this.#buf = Buffer.allocUnsafe(capacity);
  }

  get capacity(): number {
    return this.#buf.length;
  }

  /** Bytes currently retained (<= capacity). */
  get length(): number {
    return this.#filled ? this.#buf.length : this.#pos;
  }

  append(chunk: Buffer): void {
    const cap = this.#buf.length;
    if (chunk.length === 0) return;

    // A chunk at least as large as the buffer overwrites it entirely.
    if (chunk.length >= cap) {
      chunk.copy(this.#buf, 0, chunk.length - cap);
      this.#pos = 0;
      this.#filled = true;
      return;
    }

    const head = Math.min(chunk.length, cap - this.#pos);
    chunk.copy(this.#buf, this.#pos, 0, head);
    if (head < chunk.length) {
      chunk.copy(this.#buf, 0, head);
      this.#filled = true;
    }
    this.#pos = (this.#pos + chunk.length) % cap;
    if (this.#pos === 0) this.#filled = true;
  }

  /** The retained bytes, oldest first, as a fresh contiguous buffer. */
  read(): Buffer {
    if (!this.#filled) return Buffer.from(this.#buf.subarray(0, this.#pos));
    return Buffer.concat([this.#buf.subarray(this.#pos), this.#buf.subarray(0, this.#pos)]);
  }

  clear(): void {
    this.#pos = 0;
    this.#filled = false;
  }
}
