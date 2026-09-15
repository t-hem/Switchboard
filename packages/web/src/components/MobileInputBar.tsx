import { useRef, useState } from "react";

/**
 * Quick keys for the interactions that dominate phone use: answering a permission
 * prompt and moving through a menu. Each button sends exactly the one key it names,
 * so `y` does not commit on its own — confirming still takes a deliberate Enter.
 *
 * Both arrows, Space and Tab are here because a multi-select prompt needs all four:
 * arrows move the cursor, Space toggles the option under it, Tab moves between
 * questions, Enter commits. With only Up and Enter the checkboxes cannot be
 * toggled at all, and the prompt is a dead end on a phone.
 */
const QUICK_KEYS: { label: string; data: string; title: string }[] = [
  { label: "y", data: "y", title: "Send y" },
  { label: "n", data: "n", title: "Send n" },
  { label: "Esc", data: "\x1b", title: "Escape" },
  { label: "^C", data: "\x03", title: "Ctrl-C (interrupt)" },
  { label: "↑", data: "\x1b[A", title: "Up arrow" },
  { label: "↓", data: "\x1b[B", title: "Down arrow" },
  { label: "␣", data: " ", title: "Space (toggle)" },
  { label: "⇥", data: "\t", title: "Tab" },
  { label: "⏎", data: "\r", title: "Enter" },
];

/**
 * A line-input bar pinned above the soft keyboard.
 *
 * Typing into a raw terminal on a phone is miserable — autocorrect, no arrow keys,
 * and a keyboard that fights the viewport. This bar is how the phone case actually
 * works: compose a whole line, then send it with a trailing carriage return.
 */
export function MobileInputBar({
  send,
  sendLine,
  disabled,
}: {
  send: (data: string) => void;
  sendLine: (line: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement | null>(null);

  // The line and its carriage return have to reach the pty as two separate reads, or
  // the agent treats them as pasted text and never submits. `sendLine` in
  // useTerminal.ts owns that, because getting it right needs to see inbound output.
  const submit = (): void => {
    if (disabled) return;
    const line = value;
    setValue("");
    sendLine(line);
    // Keep focus so the keyboard stays up for the next line.
    input.current?.focus();
  };

  return (
    <div
      className="shrink-0 border-t border-neutral-800 bg-neutral-950 px-2 pt-2"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mb-2 flex gap-1 overflow-x-auto">
        {QUICK_KEYS.map((key) => (
          <button
            key={key.label}
            title={key.title}
            aria-label={key.title}
            disabled={disabled}
            onClick={() => send(key.data)}
            className="min-w-11 shrink-0 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-200 active:bg-neutral-700 disabled:opacity-40"
          >
            {key.label}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          placeholder="Type a line, then Send"
          aria-label="Line input"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          enterKeyHint="send"
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-base text-neutral-100 outline-none focus:border-neutral-500 disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={disabled}
          className="shrink-0 rounded bg-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900 active:bg-white disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
