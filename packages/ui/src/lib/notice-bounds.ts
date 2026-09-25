/**
 * Where the floating notice stack stands (#896): over the pane being read,
 * at a width a card can be read at, and below every toolbar it would
 * otherwise lie across.
 *
 * Plain objects rather than `DOMRect`, so this reads real measurements in
 * the app and plain numbers in a test — jsdom's own `getBoundingClientRect`
 * always answers a zero rect, so a test exercises this the same way the
 * production effect does: by handing it the rects a real layout would have
 * produced, not by rendering one.
 */
export interface RectLike {
  readonly left: number
  readonly right: number
}

export interface BoxLike extends RectLike {
  readonly top: number
  readonly bottom: number
}

/**
 * The narrowest the stack's own box ever gets, its 16px gutters included:
 * a banner's sentence and its buttons on one card without breaking a word.
 * A host narrower than this — a split's first pane dragged thin — widens
 * the stack around its own centre rather than crushing the card, and the
 * toolbar rule below keeps whatever it then reaches over clear.
 */
export const NOTICE_MIN_WIDTH = 400

/**
 * The stack's top, measured from its container, when nothing below the
 * window's 38px header strip is in its way — the value `app.css` starts
 * `.hd-floatingNotices` at before anything has been measured.
 */
export const NOTICE_FLOOR = 46

/** How far below the last toolbar it clears the stack starts. */
export const NOTICE_GAP = 8

/**
 * The CSS selector for every bar a notice must never cover: the design
 * system's bars — `Bar` (a room's header), a panel's strip (`DockPanelBar`),
 * a tool's header and bars (`ToolPaneHeader`, `ToolPaneBar`: a browser's
 * address bar, find, a repository's actions), a list's `Toolbar` — and any
 * `<header>` at all, which is how a conversation draws its own. A new screen
 * built from those parts is covered without being named here, and a bar
 * further down a pane costs nothing: only bars in the stack's way move it.
 */
export const NOTICE_BAR_SELECTOR = [
  '[data-slot="bar"]',
  '[data-slot="dock-panel-bar"]',
  '[data-slot="tool-pane-header"]',
  '[data-slot="tool-pane-bar"]',
  '[data-slot="toolbar"]',
  'header',
].join(', ')

export interface NoticePlacement {
  /** CSS `left`, from the container's left edge. */
  readonly left: number
  /** CSS `right`, from the container's right edge. */
  readonly right: number
  /** CSS `top`, from the container's top edge. */
  readonly top: number
}

const overlaps = (a: RectLike, b: RectLike): boolean => a.left < b.right && b.left < a.right

/**
 * Where the stack stands, given the host it rides and every visible bar in
 * the window.
 *
 * - **Across**: the host's own box, so it never reaches into a pane beside
 *   it — unless that box is narrower than `NOTICE_MIN_WIDTH` (a collapsed
 *   main area is zero wide), when it widens around the host's centre, kept
 *   inside `content` (the workbench's panes and panels, never the sidebar).
 *   A missing host is `content` itself.
 * - **Down**: from just under the window's header strip (or the host's own
 *   top, if lower), past every bar that crosses the stack's band and reaches
 *   into its top edge — moved to below that bar and checked again, until no
 *   bar does. Stacked headers are cleared however many there are (a room's
 *   header over its one member's conversation header, a panel's strip over
 *   a browser's address bar); a bar that only ends where the stack begins
 *   is not in its way, and one further down (a bottom panel's strip, a
 *   pane's footer) never moves it.
 */
export const noticePlacement = ({
  container,
  content,
  host,
  bars,
}: {
  /** The stack's containing block, which its CSS offsets are measured from. */
  readonly container: BoxLike
  /** The workbench's panes and panels, which the stack never leaves. */
  readonly content: BoxLike
  /** The pane or panel being read (`[data-notice-host]`), if one is marked. */
  readonly host: BoxLike | null
  /** Every visible bar in the window (`NOTICE_BAR_SELECTOR`). */
  readonly bars: readonly BoxLike[]
}): NoticePlacement => {
  const at = host ?? content
  const span = Math.max(0, content.right - content.left)
  const width = Math.min(span, Math.max(at.right - at.left, NOTICE_MIN_WIDTH))
  const centre = (at.left + at.right) / 2
  const left = Math.min(Math.max(centre - width / 2, content.left), content.right - width)
  const band = { left, right: left + width }

  let top = Math.max(container.top + NOTICE_FLOOR, at.top + NOTICE_GAP)
  for (let moved = true; moved; ) {
    moved = false
    for (const bar of bars) {
      if (bar.right <= bar.left || bar.bottom <= bar.top) continue
      if (!overlaps(bar, band)) continue
      // In the way: it reaches below the stack's top, and starts within a
      // gap of it — so a bar a few pixels under the last still counts.
      if (bar.top < top + NOTICE_GAP && bar.bottom > top) {
        top = bar.bottom + NOTICE_GAP
        moved = true
      }
    }
  }

  return {
    left: band.left - container.left,
    right: container.right - band.right,
    top: Math.ceil(top - container.top),
  }
}

/** Whether two rectangles, on both axes, overlap. */
export const boxesOverlap = (a: BoxLike, b: BoxLike): boolean =>
  overlaps(a, b) && a.top < b.bottom && b.top < a.bottom
