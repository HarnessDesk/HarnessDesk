import { measureDestination, expectPageJourney, expectDestinationTab } from './frame-page-contract'
import { expect, test, type Page } from '@playwright/test'
import { selectFrameTab } from './frame-actions'
import { openFrame } from './frame-contract-helpers'

// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

// E7 measures the real App through the assembled shared preview.
const openPlugins = async (page: Page): Promise<void> => {
  await page.locator('[data-left-column]:visible').getByRole('button', { name: 'Customize', exact: true }).click()
  await page.getByRole('radiogroup', { name: 'Customize sections', exact: true }).getByRole('radio', { name: 'Plugins', exact: true }).click()
}

for (const width of [1440, 720]) test(`E7 Customize Plugins section preserves normal history and retained work ${width}`, async ({ page }) => {
  await expectPageJourney(page, 'Customize', 'library', width)
  const sidebar = page.getByRole('dialog', { name: 'Sidebar', exact: true })
  if (await sidebar.isVisible()) await sidebar.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
  await page.getByRole('radiogroup', { name: 'Customize sections', exact: true }).getByRole('radio', { name: 'Plugins', exact: true }).click()
  await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="library"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
  await expect(page.locator('[data-page-journey="remembered"]')).toHaveCount(1)
  await page.keyboard.press('Meta+]')
  await expect(page.locator('[data-page-destination="library"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+]')
  await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(1)
})
test('E7 Plugins column New session and session rows navigate away with Back', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  const column = page.locator('[data-left-column]:visible')
  await openPlugins(page)
  await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(1)
  await column.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(0)
  await column.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(1)
  await column.locator('[data-region="session-row"] [data-slot="sidebar-menu-button"]').first().click()
  await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(0)
  await column.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(1)
})
test('E7 Plugins More offers the chosen project Terminal', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  await openPlugins(page)
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(1)
})
for (const theme of ['light', 'dark'] as const) for (const width of [2200, 1440, 1100, 720]) {
  for (const child of ['installed', 'capabilities', 'detail']) test(`E7 Plugins ${child} ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, `frame-wall=plugins&frame-plugin-page=${child}`, child === 'detail' ? 'reading' : 'wide', theme, width)
    await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
    if (child === 'detail') {
      const bar = page.locator('[data-slot="top-bar"]:visible')
      const back = page.locator('[data-page-destination="plugins"]:visible').getByRole('button', { name: 'Back to Plugins', exact: true })
      await expect(back).toBeVisible()
      await expect(bar.getByRole('button', { name: 'Back to Plugins', exact: true })).toHaveCount(0)
      await expect(bar.getByRole('tab')).toHaveCount(0)
      await back.click()
      await expect(page.getByRole('searchbox', { name: 'Search plugins', exact: true })).toBeVisible()
      await expectDestinationTab(page, 'installed')
    } else {
      await expectDestinationTab(page, child)
    }
  })
}
test('E7 Plugins capabilities and named detail share destination history', async ({ page }) => {

  await openFrame(page, 'frame-wall=plugins&frame-plugin-page=capabilities', 'dark')
  await selectFrameTab(page, 'installed')
  const plugin = page.locator('[data-plugin-id]:visible').first()
  const name = await plugin.getAttribute('data-plugin-name')
  await plugin.click()
  await expect(page.locator('[data-page-destination="plugins"]:visible h1')).toHaveText(name!)
  await page.keyboard.press('Meta+[')
  await expect(page.getByRole('searchbox', { name: 'Search plugins', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="plugins"]:visible h1')).toHaveText('Customize')
  await expectDestinationTab(page, 'capabilities')
  await expect(page.getByRole('searchbox', { name: 'Search capabilities', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+]')
  await expect(page.getByRole('searchbox', { name: 'Search plugins', exact: true })).toBeVisible()
})
test('E7 install flow uses Dialog header body and right ordered footer actions', async ({ page }) => {

  await openFrame(page, 'frame-wall=plugins', 'light')
  await page.locator('[data-page-destination="plugins"]:visible').getByRole('button', { name: 'Add plugin', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Install a plugin' })
  await expect(dialog.locator('[data-slot="dialog-head"] > span > svg')).toHaveCount(0)
  await expect(dialog.locator('[data-slot="dialog-head"]').getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  await expect(dialog.locator('[data-slot="modal-dialog-body"]')).toBeVisible()
  const actions = dialog.locator('[data-slot="dialog-footer"]')
  await expect(actions.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
  await dialog.getByRole('textbox').fill('/work/plugins/sample')
  await actions.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(dialog).toContainText('Read workspace files')
  const secondary = (await actions.getByRole('button', { name: 'Back', exact: true }).boundingBox())!
  const primary = (await actions.getByRole('button', { name: 'Install and enable', exact: true }).boundingBox())!
  expect(secondary.x + secondary.width).toBeLessThan(primary.x)
})

test('E7 Plugins pending Here keeps the host answer distinct from Anywhere', async ({ page }) => {

  await measureDestination(page, 'frame-wall=plugins&frame-plugin-page=capabilities&frame-plugin-pending=1', 'wide', 'dark', 720,
    { bodyChoice: { label: 'Where it applies', value: 'here' } })
  await expect(page.getByText('Asking the host…', { exact: true })).toBeVisible()
  await expect(page.locator('[data-page-destination="plugins"]:visible button[data-kind="record"]')).toHaveCount(0)
})
test('E7 Plugins failed detail keeps its reason and guarded source actions', async ({ page }) => {

  await measureDestination(page, 'frame-wall=plugins&frame-plugin-page=failed', 'reading', 'light', 1100)
  await expect(page.getByText('Synthetic manifest could not be loaded.', { exact: true })).toBeVisible()
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Update from source', exact: true })).toHaveCount(1)
  await expect(page.getByRole('menuitem', { name: 'Uninstall', exact: true })).toHaveCount(1)
})

{

  for (const [item0, label] of (['Agents', 'Customize', 'Dashboard', 'Settings']).entries()) test(`E7 Plugins every other normal column destination door navigates away [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, 'frame-wall=navigation', 'light')
    const column = page.locator('[data-left-column]:visible')
    await openPlugins(page)
    await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(1)
    await column.getByRole('button', { name: label, exact: true }).click()
    await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(0)

  })
}
