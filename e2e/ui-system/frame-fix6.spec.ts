import { expect, test, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const openFrame = async (page: Page, query: string, theme: 'light' | 'dark', width: number) => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  await page.evaluate(async () => { await document.fonts.ready })
}

test('R12.1 composer labels keep their full text until the fold order takes over', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720]) {
    await openFrame(page, 'frame-wall=draft&frame-composer-labels=1&frame-fix5-storefront=1', theme, width)
    const toolbar = page.locator('[data-slot="composer-tools"]')
    await expect(toolbar).toBeVisible()
    const state = await toolbar.evaluate(toolbar => {
      const labels = [...toolbar.querySelectorAll<HTMLElement>('[data-composer-track] .truncate, [data-composer-track] [data-slot="text"][title]')]
        .filter(label => label.getClientRects().length > 0)
        .map(label => ({
          track: label.closest<HTMLElement>('[data-composer-track]')?.dataset.composerTrack,
          text: label.textContent?.trim(),
          clipped: label.scrollWidth > label.clientWidth,
        }))
      const tracks = [...toolbar.querySelectorAll<HTMLElement>('[data-composer-track]')]
        .map(track => ({ track: track.dataset.composerTrack, folded: track.hasAttribute('data-folded') }))
      return { labels, tracks }
    })
    expect(state.labels.filter(label => label.clipped), `visible composer labels should fit at ${width}px in ${theme}`).toEqual([])
    if (width === 1280) {
      expect(state.labels.map(label => label.text)).toEqual(expect.arrayContaining(['storefront', 'Workspace', 'Default']))
    } else {
      const foldOrder = ['agent', 'work-in', 'more', 'context', 'mode', 'permissions', 'model']
      const folded = new Set(state.tracks.filter(track => track.folded).map(track => track.track))
      const foldedInOrder = foldOrder.filter(track => folded.has(track))
      expect(foldedInOrder).toEqual(foldOrder.filter(track => track !== 'work-in').slice(0, foldedInOrder.length))
    }
  }
})
