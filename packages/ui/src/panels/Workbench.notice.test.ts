import { describe, expect, it } from 'vitest'

import { split as splitLayout, expand as expandLayout } from '../state/layout'
import { dock, emptyWorkbench } from '../state/workbench'
import { noticeRightOffset, rightPanelDrawn } from './Workbench'

/**
 * `noticeRightOffset` is what confines the floating notice stack to the pane
 * it is about, on the right — a right panel, or an unrelated second pane
 * beside it in a split (#896). Measured live: a standing banner spanning the
 * full remaining width landed on a docked browser pane's own toolbar and
 * caught the click meant for its reload button, and the same shape of bug
 * would follow a right panel that was never accounted for at all.
 *
 * Pure, and tested as one, rather than only read off a rendered frame: a
 * frame shows one window size and one split ratio, and the values here are
 * the ones a resize or a drag actually produces.
 */
describe('noticeRightOffset', () => {
  it('is flush with the shell’s own right edge with nothing docked and nothing split', () => {
    expect(noticeRightOffset(emptyWorkbench(), 0)).toBe('0px')
  })

  it('keeps clear of a right panel by its own width, whatever that width is', () => {
    const docked = dock(emptyWorkbench(), 'right', { kind: 'tasks' })
    const workbench = { ...docked, right: { ...docked.right, size: 320 } }
    expect(rightPanelDrawn(workbench)).toBe(true)
    expect(noticeRightOffset(workbench, 0)).toBe('320px')
  })

  it('reads no width from a right panel that is collapsed to its tab strip', () => {
    const docked = dock(emptyWorkbench(), 'right', { kind: 'tasks' })
    const workbench = { ...docked, right: { ...docked.right, size: 320, collapsed: true } }
    expect(rightPanelDrawn(workbench)).toBe(false)
    expect(noticeRightOffset(workbench, 0)).toBe('0px')
  })

  /**
   * `split`'s own shortcut — reusing the existing pane rather than splitting
   * it — only fires for a *conversation* view, and only while the pane it
   * would reuse is still the empty one every fresh layout starts with. A
   * second pane view that is not a conversation always genuinely splits, and
   * is what every split fixture below asks for.
   */
  const splitRow = (): ReturnType<typeof splitLayout> => {
    const base = emptyWorkbench()
    return splitLayout(base.main, base.main.focused, 'row', { kind: 'tasks' })
  }

  it('confines to the first half of a row split of the main area, as a fraction of what the main area is given', () => {
    const split = splitRow()
    expect(split.root.kind).toBe('split')
    const workbench = { ...emptyWorkbench(), main: split }
    // A fresh split starts at an even 0.5 ratio.
    expect(noticeRightOffset(workbench, 40)).toBe('calc(0px + (100% - 40px - 0px) * 0.5)')
  })

  it('follows the ratio a split is dragged to, not only its starting half', () => {
    const split = splitRow()
    const root = split.root
    if (root.kind !== 'split') throw new Error('expected a row split')
    const dragged = { ...split, root: { ...root, ratio: 0.7 } }
    const workbench = { ...emptyWorkbench(), main: dragged }
    // The second pane — the one a notice could spill into — is 1 - 0.7 = 0.3
    // of what is left.
    expect(noticeRightOffset(workbench, 0)).toBe('calc(0px + (100% - 0px - 0px) * 0.30000000000000004)')
  })

  it('does not confine against a column split, which stacks its panes rather than placing them side by side', () => {
    const base = emptyWorkbench()
    const split = splitLayout(base.main, base.main.focused, 'column', { kind: 'tasks' })
    expect(split.root.kind).toBe('split')
    const workbench = { ...base, main: split }
    expect(noticeRightOffset(workbench, 0)).toBe('0px')
  })

  it('ignores a split once one of its panes is expanded to the whole area', () => {
    const split = splitRow()
    const expanded = expandLayout(split, split.focused)
    expect(expanded.expanded).not.toBeNull()
    const workbench = { ...emptyWorkbench(), main: expanded }
    expect(noticeRightOffset(workbench, 0)).toBe('0px')
  })

  it('combines a right panel with a row split of the main area beside it', () => {
    const docked = dock(emptyWorkbench(), 'right', { kind: 'tasks' })
    const withPanel = { ...docked, right: { ...docked.right, size: 200 } }
    const split = splitLayout(withPanel.main, withPanel.main.focused, 'row', { kind: 'tasks' })
    expect(split.root.kind).toBe('split')
    const workbench = { ...withPanel, main: split }
    expect(noticeRightOffset(workbench, 0)).toBe('calc(200px + (100% - 0px - 200px) * 0.5)')
  })
})
