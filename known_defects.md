# Known defects

Real but low-priority defects, kept out of `TODO.md` (planned work) and
`TESTING.md` (verification state). Each entry records what was observed, the
working theory, and what would confirm it. An entry is deleted when its defect
is fixed — fixed history belongs in the commit that fixed it.

## Scrollbar artifacts on full-screen TUI sessions

**Seen 2026-10-06** on a vibe session in the desktop browser, after scroll-wheel
reporting was restored (mouse-mode replay). Screenshot: `Vibe_Scrollbar_Issue.png`
in the repo root (gitignored — operator reference only).

Pixel analysis of the screenshot (right edge, `x` 561–573, near the bottom):

| y range | Appearance |
|---|---|
| 416–434 | rounded pill, light gray `rgb(170,170,170)`, ~19px tall |
| 458–472 | square block, mid gray `rgb(95,95,95)`, ~14px tall |
| 472–480 | rounded pill, pure white `rgb(255,255,255)`, ~9px tall |

The odd part: an alt-screen session should draw **no scrollbar at all** —
neither `TerminalScrollbar` (self-hides when `scrollHeight - clientHeight <= 1`)
nor xterm's native one (the alternate buffer has no scroll range). The light
and mid grays are close to the custom thumb's `bg-neutral-600` /
`active:bg-neutral-400` but match neither exactly; the white pill matches
nothing in the client and may be Chrome's default scrollbar thumb.

Working theory: at least two of {custom thumb, Chrome's default viewport
scrollbar, a stale unremoved thumb} are rendering simultaneously from metrics
that briefly had scroll range (session start, before the TUI switches to the
alternate screen) and were not cleaned up when the range collapsed.

Confirm by: reproducing with the Elements panel open — check whether
`.xterm-viewport` retains a native scrollbar and whether
`[data-testid="terminal-scrollbar-thumb"]` is in the DOM while the session is
in the alternate screen, and what `metrics` the component holds at that point.

## Screenshot-overlay hover types `^d` into sessions

**Seen 2026-10-06** (operator report, not reproduced): hovering the terminal
with the Gyazo capture overlay open sends repeated `^d` (Ctrl+D — the
composers' delete-right binding) into the session.

Appeared after mouse-mode replay shipped, so the leading suspect is an
interaction with mouse reporting: an overlay window stealing focus may push
the browser through synthetic key events, or motion reports may reach the
application in a moment it does not expect them (Textual toggles mouse
reporting off on blur). Unverified either way.

Confirm by: reproducing with the browser console and the daemon logs open —
if `^d` appears, `term.onData` logged from the browser shows which events
xterm produced; if nothing was sent, the bytes were synthesized elsewhere.
