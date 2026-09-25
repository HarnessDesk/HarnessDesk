/**
 * How far the floating notice stack keeps clear of its own containing box on
 * the left and right, so it never extends past the pane it is about (#896).
 *
 * A plain object rather than `DOMRect`, so this reads real measurements in
 * the app and plain numbers in a test — jsdom's own `getBoundingClientRect`
 * always answers a zero rect, so a test exercises this the same way the
 * production effect does: by handing it the rects a real layout would have
 * produced, not by rendering one.
 */
export interface RectLike {
  readonly left: number
  readonly right: number
}

/**
 * `left`/`right`, as CSS pixel offsets from `container`, that make the notice
 * stack's own box exactly `pane`'s box.
 *
 * Once the stack's box is the pane's box, it cannot overlap another pane's —
 * two panes never overlap each other in the split tree or the docks beside
 * it, whatever a zoom, a narrow window or a saved panel size does to their
 * own widths, because this reads the pane's rendered box directly rather
 * than reconstructing it from those. `pane` is null only when no primary
 * pane has ever mounted, and the stack answers `0`/`0` for lack of anything
 * to confine it to — a *collapsed* pane (zero width, still correctly
 * positioned) is not this case; see the branch below for why.
 */
export const noticeBounds = (
  container: RectLike,
  pane: RectLike | null,
): { readonly left: number; readonly right: number } => {
  /*
   * `pane` missing entirely — no primary pane has ever mounted — is the only
   * case answered with "nowhere to confine to, so don't." A *zero-width*
   * pane is a different fact and must not take the same branch: a panel
   * zoomed over the main area collapses it with `flex: 0 0 0`, not
   * `display: none`, so it keeps the correct position in the row and only
   * loses its extent — `getBoundingClientRect` still answers exactly where
   * the boundary is, and folding that case into "unconfined" is what let a
   * zoomed right or bottom panel's own toolbar be covered again (#896):
   * every pixel of the shell past that boundary read as fair game.
   */
  if (!pane) return { left: 0, right: 0 }
  return {
    left: Math.max(0, pane.left - container.left),
    right: Math.max(0, container.right - pane.right),
  }
}

/** Whether two axis-aligned rectangles, on the horizontal axis alone, overlap. */
export const rangesOverlap = (a: RectLike, b: RectLike): boolean => a.left < b.right && b.left < a.right
