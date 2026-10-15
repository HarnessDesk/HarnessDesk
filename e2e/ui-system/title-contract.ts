import { expect, type Locator } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

/** Short titles take their words; longer titles retain the fold's floor. */
export const expectTitleRoom = async (title: Locator): Promise<void> => {
  await expect(title).toBeAttached()
  await expect.poll(async () => title.evaluate((node, bar) => {
    // An independent, unclipped copy includes state, menu padding and caret.
    // Unlike scrollWidth, its geometry retains fractional pixels.
    const copy = node.cloneNode(true) as HTMLElement
    Object.assign(copy.style, {
      position: 'fixed', visibility: 'hidden', width: 'max-content',
      maxWidth: 'none', minWidth: 'max-content', flex: 'none',
    })
    node.parentElement!.append(copy)
    const intrinsic = copy.getBoundingClientRect().width
    copy.remove()
    const width = node.getBoundingClientRect().width
    return width + 0.5 >= Math.min(bar.titleMin, intrinsic)
      && width <= Math.min(bar.titleMax, intrinsic) + 0.5
  }, FRAME.bar), { message: 'title fits its intrinsic words or protects the long-title floor' }).toBe(true)
}
