/**
 * Normalise an `onData` payload to bytes.
 *
 * Shared deliberately rather than split per platform: what differs is what node-pty
 * *delivers*, not what we do about it. On POSIX `encoding: null` is honoured and the
 * payload is already a Buffer. On Windows it is not — the ConPTY agent calls
 * setEncoding("utf8") on the conout socket unconditionally
 * (node-pty/lib/windowsPtyAgent.js), so the option is silently ignored and every chunk
 * really is a string. Assuming otherwise threw "chunk.copy is not a function" in the
 * ring buffer on the first chunk, before any subscriber ran: the daemon looked healthy
 * and streamed nothing at all.
 *
 * Re-encoding recovers the original bytes exactly, but only for valid UTF-8, and the
 * distinction matters:
 *
 * - A multi-byte sequence split across two socket reads is NOT a problem. setEncoding
 *   installs a StringDecoder, which holds the partial bytes and emits the complete
 *   character on the next read. Verified: a box-drawing char split 1/2 and an emoji
 *   split 2/2 both arrive whole and round-trip byte-identical.
 * - Bytes that are not valid UTF-8 at all ARE lost, irrecoverably, and this function
 *   cannot help. StringDecoder replaced each one with U+FFFD inside node-pty before we
 *   were handed anything, so re-encoding faithfully reproduces the replacement
 *   character, not the original byte. A child writing in the console's OEM codepage
 *   (cp437 box drawing, say) rather than UTF-8 is the realistic way to hit this, and
 *   it shows up as mojibake.
 *
 * Fixing that properly means node-pty honouring `encoding: null` on Windows, or
 * reading the conout pipe directly. Out of scope here; documented so it is findable.
 * Note the consequence for RingBuffer's "preserves arbitrary binary bytes" test: that
 * guarantee holds on POSIX and cannot hold on Windows.
 */
export function ptyChunkToBytes(data: string | Buffer): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : data;
}
