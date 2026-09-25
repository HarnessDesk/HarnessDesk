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
 * The CSS selector for every bar a notice must never cover: a panel's own
 * strip (`DockPanelBar`), a tool's header (`ToolPaneHeader`) and a tool's
 * bars (`ToolPaneBar` — a browser's address bar, find, a repository's
 * actions). The design system's own slots, so a new screen built from those
 * parts is covered without being named here.
 */
export const NOTICE_BAR_SELECTOR = [
  '[data-slot="dock-panel-bar"]',
  '[data-slot="tool-pane-header"]',
  '[data-slot="tool-pane-bar"]',
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
 * - **Down**: below the run of bars that starts at the host's top edge and
 *   crosses the stack's band — a panel's strip, then a browser's address bar
 *   under it, and so on while each one starts where the last ended. A bar
 *   further down (a bottom panel's strip, a pane's footer) is not in that run
 *   and does not move the stack.
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

  let edge = at.top
  for (let moved = true; moved; ) {
    moved = false
    for (const bar of bars) {
      if (bar.right <= bar.left || bar.bottom <= bar.top) continue
      if (!overlaps(bar, band)) continue
      // One pixel of slack: a border or a sub-pixel seam between two bars
      // stacked one under the other is still one run.
      if (bar.top <= edge + 1 && bar.bottom > edge) {
        edge = bar.bottom
        moved = true
      }
    }
  }

  return {
    left: band.left - container.left,
    right: container.right - band.right,
    top: Math.max(NOTICE_FLOOR, Math.ceil(edge + NOTICE_GAP - container.top)),
  }
}

/** Whether two rectangles, on both axes, overlap. */
export const boxesOverlap = (a: BoxLike, b: BoxLike): boolean =>
  overlaps(a, b) && a.top < b.bottom && b.top < a.bottom
