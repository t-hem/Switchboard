import { useEffect, useRef, useState } from "react";

/** Never smaller than this, however long the scrollback gets — it has to stay grabbable. */
const MIN_THUMB_PX = 44;

type Metrics = { top: number; scrollHeight: number; clientHeight: number };

/**
 * A scrollbar wide enough to drag with a thumb.
 *
 * The browser's own is no use here. Phones use overlay scrollbars, which ignore
 * `::-webkit-scrollbar` styling entirely — measured at 0px of layout width — so the
 * viewport's real scrollbar cannot be widened, and a hairline that fades after a
 * moment is not something you can grab anyway.
 *
 * So this draws its own, over the terminal, and drives `scrollTop` directly.
 * xterm's viewport already syncs its buffer from a plain `scroll` event, so setting
 * `scrollTop` is all it takes — no xterm API is involved.
 *
 * This is the fallback for the momentum fix in index.css: if handing touch
 * scrolling back to the browser does not hold on some handset, this still works.
 */
export function TerminalScrollbar({ viewport }: { viewport: HTMLElement | null }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const dragRef = useRef<{ startY: number; startTop: number } | null>(null);

  useEffect(() => {
    if (!viewport) return;
    let frame = 0;
    const sync = (): void => {
      frame = 0;
      setMetrics({
        top: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      });
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(sync);
    };
    sync();
    viewport.addEventListener("scroll", schedule, { passive: true });
    // The viewport's own size, and `.xterm-scroll-area`, whose height *is* the
    // buffer's — it grows with every line, which is what shrinks the thumb.
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    const area = viewport.firstElementChild;
    if (area) observer.observe(area);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [viewport]);

  if (!viewport || !metrics) return null;
  const { top, scrollHeight, clientHeight } = metrics;
  const maxScroll = scrollHeight - clientHeight;
  // Nothing to scroll: a full-height thumb would only be in the way.
  if (maxScroll <= 1) return null;

  const thumbHeight = Math.min(clientHeight, Math.max(MIN_THUMB_PX, clientHeight * (clientHeight / scrollHeight)));
  const maxThumbTop = clientHeight - thumbHeight;
  const thumbTop = (top / maxScroll) * maxThumbTop;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, startTop: viewport.scrollTop };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || maxThumbTop <= 0) return;
    const travelled = event.clientY - drag.startY;
    viewport.scrollTop = drag.startTop + (travelled / maxThumbTop) * maxScroll;
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      // `top-1` matches the p-1 the terminal sits in, and the track is exactly as
      // tall as the viewport — so thumb position is a straight proportion of
      // scrollTop, with no offset to correct for.
      // Not touch-only. A desktop with a dead scroll wheel has no other way back
      // through the buffer, and ↓ Latest never appears because nothing can scroll
      // away from the bottom in the first place.
      className="absolute right-0 top-1 w-4"
      style={{ height: clientHeight }}
      aria-hidden
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid="terminal-scrollbar-thumb"
        // `touch-action: none` or the browser scrolls the page out from under the drag.
        className="absolute right-0.5 w-3 rounded-full bg-neutral-600 active:bg-neutral-400"
        style={{ top: thumbTop, height: thumbHeight, touchAction: "none" }}
      />
    </div>
  );
}
