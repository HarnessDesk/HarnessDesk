import { measureDestination, expectPageJourney, expectDestinationTab } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { selectFrameTab } from './frame-actions'
import { openFrame } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })



// E6 owns Library's main-page door; the shared preview assembly is retired in E9.
for (const width of [1440, 720]) test(`E6 Library door preserves normal history and retained work ${width}`, async ({ page }) => {
  await expectPageJourney(page, 'Library', 'library', width)
})
test('E6 Library has its own crumb and applicable More actions', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=library&frame-no-folder=1', 'light')
  const bar = page.locator('[data-slot="top-bar"]:visible')
  await expect(bar.locator('[data-topbar-title]')).toHaveText('Library')
  await expect(bar.getByText('Settings', { exact: true })).toHaveCount(0)
  await bar.getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Back to app', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Import', exact: true })).toHaveCount(1)
  await expect(page.getByRole('menuitem', { name: 'Rescan', exact: true })).toHaveCount(1)
})
for (const width of [1440, 720]) test(`E6 Library column sessions and New session navigate away ${width}`, async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light', width)
  const reveal = async () => { if (width < FRAME.fold.sidebarFloats) await page.getByRole('button', {name:'Show sidebar',exact:true}).click() }
  await reveal()
  const column = page.locator('[data-left-column]:visible')
  const door = column.getByRole('button', { name: 'Library', exact: true })
  await door.click()
  await reveal()
  await column.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('[data-page-destination="library"]:visible')).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
  await reveal()
  await column.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-page-destination="library"]:visible')).toHaveCount(1)
  await reveal()
  await column.getByRole('button', { name: 'Worktree Management', exact: true }).click()
  await expect(page.locator('[data-page-destination="library"]:visible')).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
})

for (const theme of ['light', 'dark'] as const) for (const width of [2200, 1440, 1100, 720]) {
  for (const kind of ['skill', 'mcp'] as const) test(`E6 Library ${kind} ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, 'frame-wall=settings&frame-section=library', 'wide', theme, width, { tab: kind })
    await expectDestinationTab(page, kind)
    await expect(page.locator('[data-slot="library-toolbar"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
  })
}
test('E6 Library retains search and matrix under another destination', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=library', 'light')
  await page.getByRole('searchbox', { name: 'Search library', exact: true }).fill('design')
  await page.locator('[data-slot="page-options"] [data-slot="popover-trigger"][title="How to show the library"]').click()
  await page.getByRole('menuitemradio', { name: 'Matrix', exact: true }).click()
  await page.keyboard.press('Meta+,')
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+[')
  await expect(page.getByRole('searchbox', { name: 'Search library', exact: true })).toHaveValue('design')
  await expect(page.locator('[data-slot="library-matrix"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-page-destination="library"]')).toBeHidden()
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
})
test('E6 Library sections record visits while retaining local choices', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=library', 'light')
  await expectDestinationTab(page, 'skill')
  await page.getByRole('searchbox', { name: 'Search library', exact: true }).fill('design')
  await selectFrameTab(page, 'mcp')
  await expectDestinationTab(page, 'mcp')
  await page.keyboard.press('Meta+[')
  await expectDestinationTab(page, 'skill')
  await page.keyboard.press('Meta+]')
  await expectDestinationTab(page, 'mcp')
  await expect(page.getByRole('searchbox', { name: 'Search library', exact: true })).toHaveValue('design')
})
for (const label of ['Teams', 'Agents', 'Plugins', 'Dashboard', 'Settings']) test(`E6 Library column ${label} door navigates away`, async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=library', 'light')
  const column = page.locator('[data-left-column]:visible')
  await column.getByRole('button', { name: label, exact: true }).click()
  await expect(page.locator('[data-page-destination="library"]:visible')).toHaveCount(0)
  if (label === 'Settings') await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
})

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`E6 Library expanded matrix stays inside its page ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, 'frame-wall=settings&frame-section=library', 'wide', theme, width,
      {bodyChoice:{label:'How to show the library',value:'matrix',item:'Matrix'}})
    const disclosure = page.locator('[data-slot="library-matrix"] tbody tr').first().getByRole('button').first()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await disclosure.click()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[data-slot="library-matrix"]')).toBeVisible()
    await expect(page.locator('[data-slot="library-legend"]')).toBeVisible()
    await expect(page.getByText('Advertised each turn', {exact:true})).toBeVisible()
    await expect(page.getByText(/cop(?:y|ies) on disk/).first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
for (const theme of ['light', 'dark'] as const) for (const width of [1440, 720]) {
  test(`E6 Library import uses shared slots and a search glyph ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings&frame-section=library', theme, width)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await bar.getByRole('button', {name:'More',exact:true}).click()
    await page.getByRole('menuitem', {name:'Import',exact:true}).click()
    const dialog = page.getByRole('dialog', {name:'Import between agents',exact:true})
    await expect(dialog.locator('[data-slot="dialog-head"] svg')).toHaveCount(1)
    await expect(dialog.locator('[data-slot="modal-dialog-body"] [data-slot="search"] svg')).toHaveCount(1)
    await dialog.getByRole('searchbox', {name:'Search imports',exact:true}).fill('review')
    await expect(dialog.getByRole('searchbox', {name:'Search imports',exact:true})).toHaveValue('review')
    const footer = dialog.locator('[data-slot="dialog-footer"]')
    const preview = await footer.getByRole('button',{name:'Preview',exact:true}).boundingBox()
    const cancel = await footer.getByRole('button',{name:'Cancel',exact:true}).boundingBox()
    expect(cancel!.x).toBeLessThan(preview!.x)
    await footer.getByRole('button',{name:'Cancel',exact:true}).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-page-destination="library"]')).toBeVisible()
  })
}
// Shared TopBarOutlet policy is owned by the play/foundation integration.
// This owner regression remains red until the play merge supplies folder-bound action policy.
test('E6 Library More excludes Terminal even with retained work in a folder', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings&frame-section=library', 'light')
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button',{name:'More',exact:true}).click()
  await expect(page.getByRole('menuitemradio',{name:/Terminal/})).toHaveCount(0)
  await expect(page.getByRole('menuitem',{name:'Back to app',exact:true})).toHaveCount(0)
})
