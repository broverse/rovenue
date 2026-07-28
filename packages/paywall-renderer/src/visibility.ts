import { useEffect, useState } from "react";

/**
 * The fraction of a node that must be inside the viewport before it counts as
 * on-screen. Zero — a single intersecting pixel is enough — which is the
 * `IntersectionObserver` default, spelled out here rather than left implicit
 * so the answer to "how much of it has to show?" lives at one named place for
 * every time-driven node (countdown, carousel, and the media nodes that join
 * them).
 */
export const NODE_VISIBLE_INTERSECTION_THRESHOLD = 0;

/** True when the tab itself is showing. A hidden tab's `setInterval` is
 * throttled to roughly one call a minute anyway, so leaving timers running
 * buys nothing and costs a wakeup — and media playing into a hidden tab costs
 * battery and cellular data on top. Non-DOM environments (SSR) count as
 * visible: the same fail-open rule as below. */
function isDocumentVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

/**
 * Is this node actually on screen right now? The one answer every time-driven
 * node type asks for — countdown ticks, carousel auto-advance, video and
 * lottie playback — built ONCE here rather than reimplemented per node type.
 *
 * Two independent signals compose into it: the DOCUMENT is visible (the tab
 * is not backgrounded), AND the ELEMENT intersects the viewport. A visible tab
 * is not the same as a visible paywall — the node can be scrolled out of the
 * scroller, or sit on a funnel step behind an overlay — which is why the
 * second half exists.
 *
 * Pass the element from a CALLBACK REF (`const [el, setEl] = useState(null)`),
 * not a `useRef` object: the observer effect must re-run when the element
 * actually appears, and a ref object's mutation does not re-run it.
 *
 * Absent `IntersectionObserver` (jsdom, very old engines) the node stays
 * on-screen — fail open, never a stopped clock and never a stalled carousel.
 */
export function useNodeVisible(element: HTMLElement | null): boolean {
  const [onScreen, setOnScreen] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(isDocumentVisible);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => setDocumentVisible(isDocumentVisible());
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setOnScreen(entry.isIntersecting);
      },
      { threshold: NODE_VISIBLE_INTERSECTION_THRESHOLD },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return onScreen && documentVisible;
}
