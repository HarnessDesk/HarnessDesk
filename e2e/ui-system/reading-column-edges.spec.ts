import { expect, test, type Page } from '@playwright/test'

/**
 * The transcript and its composer share both edges, at every pane width.
 *
 * #1016's review: below about 816px of pane the transcript ran 16px narrower
 * than the composer under it. `PaneColumn`'s own `reading` inset added the
 * scrollbar's width a second time, on top of what the transcript's own
 * scroll box already reserves physically (`scrollbar-gutter: stable
 * both-edges`). Above the reading column's own 736px cap neither edge shows
 * it — both sit centred and narrower than the pane either way, which is why
 * the wide, AE-0 frames that shipped the regression never caught it.
 */

const edges = (page: Page) =>
  page.evaluate(() => {
    // `[data-part]` is the turn's own wrapper and carries no cap of its own;
    // its child (`ItemView`'s own root) is what actually sits in the reading
    // column, the same element `conversation-map.spec.ts` reads.
    const prompt = document.querySelector('[data-live-transcript] [data-part] > *') as HTMLElement | null
    const conversation = prompt?.closest('[class*="_conversation_"]') as HTMLElement | null
    const composer = conversation?.querySelector('[data-slot="composer"]') as HTMLElement | null
    if (!prompt) throw new Error('no turn in the live transcript')
    if (!composer) throw new Error('no composer shell in the same conversation')
    const promptBox = prompt.getBoundingClientRect()
    const composerBox = composer.getBoundingClientRect()
    return {
      promptLeft: promptBox.left,
      promptRight: promptBox.right,
      composerLeft: composerBox.left,
      composerRight: composerBox.right,
    }
  })

for (const width of [500, 700, 900, 1400]) {
  test(`the transcript and the composer share both edges at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/preview.html')
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    await page.waitForTimeout(400)

    const { promptLeft, promptRight, composerLeft, composerRight } = await edges(page)
    expect(Math.abs(promptLeft - composerLeft), 'left edge').toBeLessThanOrEqual(1)
    expect(Math.abs(promptRight - composerRight), 'right edge').toBeLessThanOrEqual(1)
  })
}
