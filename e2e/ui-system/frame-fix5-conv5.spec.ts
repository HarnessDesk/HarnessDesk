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

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R11.6 runtime row subtitles start at the title text edge') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {

await openFrame(page, 'frame-wall=conversation&frame-fix5-runtime-unavailable=1&frame-no-folder=1', theme, width)
const rows = page.locator('[data-slot="list-row"]:visible')
await expect(rows.first()).toBeVisible()
const alignments = await rows.evaluateAll(rows => rows.map(row => {
      const firstTextLeft = (element: Element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let text: Node | null
        while ((text = walker.nextNode())) {
          if (!text.textContent?.trim()) continue
          const range = document.createRange()
          range.selectNodeContents(text)
          return range.getBoundingClientRect().left
        }
        throw new Error('row text is missing')
      }
      return {
        title: firstTextLeft(row.querySelector('[data-slot="list-row-title"]')!),
        subtitle: firstTextLeft(row.querySelector('[data-slot="list-row-subtitle"]')!),
      }
    }))
expect(alignments).toHaveLength(5)
for (const alignment of alignments) {
      expect(alignment.subtitle, `subtitle should begin under the title at ${width}px in ${theme}`).toBeCloseTo(alignment.title, 1)
    }


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R11.1 selected project appears in the new conversation pitch and folder control') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {

await openFrame(page, 'frame-wall=draft&frame-fix5-storefront=1', theme, width)
await expect(page.getByText('Describe what you want done in storefront.', { exact: true })).toBeVisible()
await expect(page.locator('[data-composer-track="work-in"]')).toContainText('storefront')
await openFrame(page, 'frame-wall=draft&frame-fix5-long-folder=1', theme, width)
const folder = page.locator('[data-composer-track="work-in"] [data-slot="text"][title*="this-is-a-very-long"]')
const truncation = await folder.evaluate(element => ({
      textOverflow: getComputedStyle(element).textOverflow,
      whiteSpace: getComputedStyle(element).whiteSpace,
      overflow: getComputedStyle(element).overflow,
      clipped: element.scrollWidth > element.clientWidth,
    }))
expect(truncation).toEqual({ textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden', clipped: true })


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R11.2 command approval separates one primary action and shortcut keys') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {

await openFrame(page, 'frame-wall=conversation&frame-fix5-command-approval=1', theme, width)
const dialog = page.getByRole('dialog')
await expect(dialog).toBeVisible()
const allow = dialog.getByRole('button', { name: 'Allow', exact: true })
const session = dialog.getByRole('button', { name: 'Allow for this session', exact: true })
await expect(allow).toBeVisible()
await expect(session).toBeVisible()
await expect(allow).toHaveAttribute('data-variant', 'default')
await expect(session).toHaveAttribute('data-variant', 'quiet')
await expect(dialog.locator('[data-slot="keycap"]')).toHaveCount(3)


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R11.3 the provisional conversation title matches in the bar and selected row') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {
const task = 'List the storefront files and tell me where the product cards are implemented.'
await openFrame(page, 'frame-wall=conversation&frame-fix5-live-title=1', theme, width)
await expect(page.locator('[data-topbar-title]')).toContainText(task.slice(0, 54))
const selected = page.locator('[data-region="session-row"] [aria-current="page"]')
await expect(selected).toHaveAttribute('aria-label', task)
await expect(selected).not.toContainText('Untitled session')


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R11.4 empty Changes and review surfaces replace their controls') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {

await openFrame(page, 'frame-wall=conversation&frame-tool=changes&frame-fix5-no-changes=1', theme, width)
await expect(page.getByText('No changes yet', { exact: true })).toBeVisible()
await expect(page.getByPlaceholder('Filter files')).toHaveCount(0)
await expect(page.getByRole('button', { name: 'Open review' })).toHaveCount(0)
await openFrame(page, 'frame-wall=changes-review&frame-review-scene=empty', theme, width)
await expect(page.getByText('No changes yet', { exact: true })).toBeVisible()
await expect(page.getByPlaceholder('Filter files')).toHaveCount(0)


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R11.5 a saved conversation without its runtime keeps its title and selection') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {

await openFrame(page, 'frame-wall=conversation&frame-fix5-missing-runtime=1', theme, width)
await expect(page.locator('[data-topbar-title]')).toContainText('Judge the storefront layout')
const selected = page.locator('[data-region="session-row"] [aria-current="page"]')
await expect(selected).toHaveAttribute('aria-label', 'Judge the storefront layout')
await expect(page.getByText("This conversation can't be read because its runtime isn't installed. Add it in Settings, then reopen this conversation.", { exact: true })).toBeVisible()
await expect(page.getByText('What should we build?', { exact: true })).toHaveCount(0)
await expect(page.locator('textarea')).toHaveCount(0)


})
}
