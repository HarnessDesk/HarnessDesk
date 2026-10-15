import { expect, test, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const openPreview = async (page: Page, query: string, theme: 'light' | 'dark', width: 1280 | 720) => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  await page.evaluate(async () => { await document.fonts.ready })
}

const longHomePath = '/private/tmp/synthetic-agent-fixture/isolated/worker/worktrees/round-four/app-frame-fix4-lists4/shared-home/profile/.harnessdesk/agents'

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 720] as const) {
  test(`Agent rows and detail share the local seat answer; the source path stays inline at ${width}px in ${theme}`, async ({ page }) => {
    await openPreview(
      page,
      'frame-wall=agents&frame-agent-case=local-seat-mismatch&frame-agent-path=long',
      theme,
      width,
    )

    const reviewer = page.locator('section[aria-label="In storefront"] button[data-kind="record"]').filter({ hasText: 'Code reviewer' })
    await expect(reviewer).toHaveCount(1)
    await expect(reviewer.locator('[data-slot="row-desc"]')).toHaveText('The storefront team’s reviewer: reads the diff against our checkout rules. · Gamma is signed out')
    await expect(reviewer).toContainText("Can't seat here")
    await expect(reviewer).not.toContainText("Set by this file's older permission line")
    await expect(page.locator('section[aria-label="Yours"]')).not.toContainText("Set by this file's older permission line, which counts as Publish.")

    const source = page.locator('section[aria-label="Yours"] [data-slot="note"]')
    const path = source.locator('[data-slot="middle-truncate"]')
    await expect(path).toHaveAttribute('title', longHomePath)
    const noteGeometry = await source.evaluate(note => {
      const parts = [...note.children].map(part => part.getBoundingClientRect())
      return {
        oneLine: parts.every(part => Math.abs(part.top - parts[0]!.top) < 1),
        fits: note.scrollWidth <= note.clientWidth + 1,
        height: note.getBoundingClientRect().height,
        pathWidth: note.querySelector<HTMLElement>('[data-slot="middle-truncate"]')?.getBoundingClientRect().width ?? 0,
      }
    })
    expect(noteGeometry.oneLine).toBe(true)
    expect(noteGeometry.fits).toBe(true)
    expect(noteGeometry.pathWidth).toBeGreaterThan(0)
    expect(noteGeometry.height).toBeLessThan(32)

    await reviewer.click()
    await expect(page.locator('section[aria-label="Seats"]')).toContainText('Not used on this Mac')
    await expect(page.locator('section[aria-label="Seats"]')).toContainText('Free here')
    await expect(page.locator('section[aria-label="On this Mac"]')).toContainText('Gamma is signed out')
    await expect(page.getByText("Set by this file's older permission line, which counts as Edit.")).toHaveCount(1)
  })

  test(`plugin tool descriptions have short labels and stay as second lines at ${width}px in ${theme}`, async ({ page }) => {
    await openPreview(page, 'frame-wall=plugins&frame-plugin-page=detail', theme, width)

    const tools = page.locator('section[aria-label="Tools"] [data-slot="row"]')
    await expect(tools).toHaveCount(14)
    const expected = [
      ['Open a page', 'Open a URL in the browser and return a screenshot.'],
      ['Screenshot', 'Screenshot the browser as it is right now'],
      ['Read the page', 'What is on the page: an accessibility outline'],
      ['Click', 'Click an element by its ref'],
      ['Pointer', 'Pointer gestures beyond a click'],
      ['Press a key', 'Press a key, optionally several times'],
      ['Type', 'Type a whole string'],
      ['Fill a form', 'Set a form control to a value'],
      ['The page itself', 'The page itself: go back or forward'],
    ] as const
    for (const [index, [label, sentence]] of expected.entries()) {
      const row = tools.nth(index)
      await expect(row.locator('[data-slot="row-title"]')).toHaveText(label)
      await expect(row.locator('[data-slot="row-desc"]')).toContainText(sentence)
    }
    const labels = await tools.locator('[data-slot="row-title"]').allTextContents()
    expect(labels).not.toContain('browser_open')
    expect(labels).not.toContain('browser/browser_open')

    await page.getByRole('switch', { name: 'Show tool names' }).click()
    await expect(tools.first().locator('[data-slot="row-title"]')).toHaveText('browser/browser_open')
    await expect(tools.first().locator('[data-slot="row-desc"]')).toContainText('Open a URL in the browser and return a screenshot.')
  })
}
