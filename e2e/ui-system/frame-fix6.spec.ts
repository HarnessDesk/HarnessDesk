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

const openInvestigation = async (page: Page, theme: 'light' | 'dark', width: number) => {
  await openFrame(page, 'team-start=picker', theme, width)
  await page.getByRole('button', { name: 'Investigation', exact: true }).click()
  return page.getByRole('dialog')
}

test('R12.2 the New Team footer stays in place between steps', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720]) {
    await openFrame(page, 'team-start=picker', theme, width)
    const dialog = page.getByRole('dialog')
    const geometry = async () => dialog.evaluate(element => {
      const footer = element.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!
      return { top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height, footerTop: footer.getBoundingClientRect().top }
    })
    const picker = await geometry()
    await page.getByRole('button', { name: 'Investigation', exact: true }).click()
    const form = await geometry()
    expect(form.height, `dialog height at ${width}px in ${theme}`).toBeCloseTo(picker.height, 1)
    expect(form.footerTop, `footer position at ${width}px in ${theme}`).toBeCloseTo(picker.footerTop, 1)
    expect(form.top, `dialog top at ${width}px in ${theme}`).toBeCloseTo(picker.top, 1)
  }
})

test('R12.3 Back puts its text on the footer edge and its plate past it', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720]) {
    const dialog = await openInvestigation(page, theme, width)
    const alignment = await dialog.evaluate(element => {
      const footer = element.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!
      const navigation = footer.querySelector<HTMLElement>('[data-slot="dialog-footer-navigation"]')!
      const back = [...navigation.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Back')!
      const range = document.createRange()
      range.selectNodeContents(back)
      return { text: range.getBoundingClientRect().left, edge: navigation.getBoundingClientRect().left, plate: back.getBoundingClientRect().left }
    })
    expect(Math.abs(alignment.text - alignment.edge), `Back text edge at ${width}px in ${theme}`).toBeLessThanOrEqual(1)
    expect(alignment.plate, `Back plate should outdent at ${width}px in ${theme}`).toBeLessThan(alignment.edge)
  }
})

test('R12.4 the New Team role name uses sentence case', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720]) {
    const dialog = await openInvestigation(page, theme, width)
    const role = dialog.locator('[aria-label="Who does what"] [data-slot="row-title"]').first()
    await expect(role).toHaveText('Research')
    await expect(role).not.toHaveText('research')
  }
})

test('R12.5 Details uses the shared disclosure chevron', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720]) {
    const dialog = await openInvestigation(page, theme, width)
    const details = dialog.getByRole('button', { name: 'Details', exact: true })
    await expect(details).toHaveAttribute('aria-expanded', 'false')
    await expect(dialog.locator('details')).toHaveCount(0)
    await expect(dialog.locator('[data-flow-details]')).toBeHidden()
    const chevron = details.locator('[data-slot="disclosure-chevron"]')
    await expect(chevron).toBeVisible()
    await details.click()
    await expect(details).toHaveAttribute('aria-expanded', 'true')
    await expect(chevron).toHaveAttribute('data-open', '')
    await expect(dialog.locator('[data-flow-details]')).toBeVisible()
  }
})

test('R12.7 an unavailable conversation keeps the message in its body without repeating it in the strip', async ({ page }) => {
  const message = 'A runtime was found at /work/fixture/bin/agent, but did not report its version.'
  for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720]) {
    await openFrame(page, 'frame-wall=conversation&frame-fix6-runtime-unavailable=1', theme, width)
    await expect(page.locator('[data-slot="conversation-empty-state"]')).toContainText(message)
    await expect(page.locator('[data-slot="notice-strip"]')).toHaveCount(0)
  }
})
