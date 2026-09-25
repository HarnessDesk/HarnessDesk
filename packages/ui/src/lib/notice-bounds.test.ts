import { describe, expect, it } from 'vitest'

import { noticeBounds, rangesOverlap, type RectLike } from './notice-bounds'

/** The box the notice stack would end up with, given these two rects. */
const stackBox = (container: RectLike, pane: RectLike | null): RectLike => {
  const bounds = noticeBounds(container, pane)
  return { left: container.left + bounds.left, right: container.right - bounds.right }
}

describe('noticeBounds', () => {
  it('is the whole container when the pane fills it, with nothing else beside it', () => {
    const container = { left: 240, right: 1024 }
    expect(noticeBounds(container, { left: 240, right: 1024 })).toEqual({ left: 0, right: 0 })
  })

  it('confines to a pane narrower than the container, on both sides at once', () => {
    const container = { left: 240, right: 1024 }
    const pane = { left: 240, right: 690 }
    expect(noticeBounds(container, pane)).toEqual({ left: 0, right: 334 })
  })

  it('answers 0/0 — unconfined — only when no primary pane has ever mounted', () => {
    expect(noticeBounds({ left: 0, right: 1024 }, null)).toEqual({ left: 0, right: 0 })
  })

  /**
   * The three shapes measured live and found still broken (#896): the right
   * edge came from `workbench.right.size`, the width a panel was last
   * *dragged* to — not what a zoom or a narrow window resize it to on
   * screen — so each of these still let a banner spill past the real
   * boundary and cover the other pane's own toolbar. Every rect below is a
   * plausible one for its scenario, not a live measurement; jsdom's own
   * `getBoundingClientRect` cannot produce one, which is why this is a unit
   * test on the rects rather than a rendered one (`Panes.module.css`'s own
   * comment on `.main[data-hidden]` is where the zero-width, correctly
   * positioned shape below comes from: `flex: 0 0 0`, not `display: none`,
   * so the collapsed pane keeps its real position in the row).
   */
  describe('the three shapes that broke the saved-size version', () => {
    it('a right panel zoomed over the main pane: the main pane collapses to zero width at the true boundary, not the panel’s own last-dragged width', () => {
      const container = { left: 240, right: 1280 }
      // `.main[data-hidden]` keeps the row's order: a zero-width pane sits at
      // the boundary the zoomed panel now starts from, not at `container.right`.
      const collapsedMain = { left: 240, right: 240 }
      const zoomedRightPanel = { left: 240, right: 1280 }
      const stack = stackBox(container, collapsedMain)
      expect(stack).toEqual({ left: 240, right: 240 })
      expect(rangesOverlap(stack, zoomedRightPanel)).toBe(false)
    })

    it('a bottom panel zoomed over the whole content row: the main pane collapses the same way, whichever area actually took the zoom', () => {
      // `areaVisible` answers the same "not this one" for `main` whether the
      // zoom names `right` or `bottom` — the shape a zoomed-away pane leaves
      // behind does not depend on which sibling area took its place.
      const container = { left: 240, right: 1280 }
      const collapsedMain = { left: 240, right: 240 }
      const zoomedBottomPanel = { left: 240, right: 1280 }
      const stack = stackBox(container, collapsedMain)
      expect(stack).toEqual({ left: 240, right: 240 })
      expect(rangesOverlap(stack, zoomedBottomPanel)).toBe(false)
    })

    it('a narrow window with the right panel open: the right panel overlays rather than sharing the row, so the main pane is not narrowed by the panel’s saved width at all', () => {
      // `.shell[data-narrow] .right` becomes `position: absolute; inset: 0` —
      // out of the flex row the saved `workbench.right.size` sized it in —
      // so the main pane takes the row's whole width rather than that saved
      // width's worth less of it. Confining to the main pane's own (now
      // full-width) box does not, on its own, avoid the overlay above it;
      // it only stops answering a boundary partway across the window that
      // nothing on screen actually draws.
      const container = { left: 0, right: 768 }
      const mainAtFullWidth = { left: 0, right: 768 }
      const stack = stackBox(container, mainAtFullWidth)
      expect(stack).toEqual(container)
    })
  })
})
