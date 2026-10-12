import { measureDestination, expectPageJourney, expectDestinationTab } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { selectFrameTab } from './frame-actions'
import { openFrame } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


// E7 measures the real App through the assembled shared preview.

for (const width of [1440, 720]) test(`E7 Plugins door preserves normal history and retained work ${width}`, async ({ page }) => {
  await expectPageJourney(page, 'Plugins', 'plugins', width)
})
test('E7 Plugins column New session and session rows navigate away with Back', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  const column = page.locator('[data-left-column]:visible')
  const plugins = column.getByRole('button', { name: 'Plugins', exact: true })
  await plugins.click()
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
test('E7 Plugins omits More when the page has no actions', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  await page.locator('[data-left-column]:visible').getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button')).toHaveCount(0)
})
for (const theme of ['light', 'dark'] as const) for (const width of [2200, 1440, 1100, 720]) {
  for (const child of ['installed', 'capabilities', 'detail']) test(`E7 Plugins ${child} ${width} ${theme}`, async ({ page }) => {
    await measureDestination(page, `frame-wall=plugins&frame-plugin-page=${child}`, child === 'detail' ? 'reading' : 'wide', theme, width, { more: 'absent' })
    await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
    if (child === 'detail') {
      await expect(page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Plugins ›', exact: true })).toBeVisible()
      await expect(page.locator('[data-slot="top-bar"]:visible').getByRole('tab')).toHaveCount(0)
    } else {
      const { expectDestinationTab } = await import('./frame-page-contract')
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
  await expect(page.locator('[data-slot="top-bar"]:visible')).toContainText(name!)
  await page.keyboard.press('Meta+[')
  await expect(page.getByRole('searchbox', { name: 'Search plugins', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-slot="top-bar"]:visible')).toContainText('Capabilities')
  await page.keyboard.press('Meta+]')
  await expect(page.getByRole('searchbox', { name: 'Search plugins', exact: true })).toBeVisible()
})
test('E7 install flow uses Dialog header body and right ordered footer actions', async ({ page }) => {

  await openFrame(page, 'frame-wall=plugins', 'light')
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'Add plugin', exact: true }).click()
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
    { more: 'absent', bodyChoice: { label: 'Where it applies', value: 'here' } })
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

  for (const [item0, label] of (['Agents', 'Library', 'Dashboard', 'Settings']).entries()) test(`E7 Plugins every other normal column destination door navigates away [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, 'frame-wall=navigation', 'light')
    const column = page.locator('[data-left-column]:visible')
    await column.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(1)
    await column.getByRole('button', { name: label, exact: true }).click()
    await expect(page.locator('[data-page-destination="plugins"]:visible')).toHaveCount(0)


  })
}
