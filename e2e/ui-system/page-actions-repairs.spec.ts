import { expect, test, type Locator, type Page } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

const capture = async (page: Page, name: string) => {
  if (process.env.HD_PAGE_REPAIR_FRAMES) await page.screenshot({ path: `${process.env.HD_PAGE_REPAIR_FRAMES}/${name}.png` })
}

// Footer actions paint in reverse order. The proceeding action must be the
// filled button in the first DOM position and to the right of Cancel.
const primaryRightmost = async (dialog: Locator, label: string) => {
  const actions = dialog.locator('[data-slot="dialog-footer-actions"] button')
  await expect(actions.first()).toHaveAttribute('data-filled', '')
  await expect(actions.first()).toHaveText(label)
  const primary = (await actions.first().boundingBox())!, cancel = (await actions.last().boundingBox())!
  expect(primary.x).toBeGreaterThan(cancel.x)
}

for (const theme of ['light', 'dark'] as const) {
  test(`Settings body actions survive the quiet bar in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings&frame-detail=skill', theme)
    const settings = page.locator('[data-page-destination="settings"]:visible')
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
    await expect(settings.getByRole('button', { name: 'Use in composer', exact: true })).toBeVisible()
    await capture(page, `settings-skill-${theme}`)

    await openFrame(page, 'frame-wall=settings&frame-detail=runtime', theme)
    await expect(settings.locator('[data-slot="chip"]').filter({ hasText: /^Default$/ })).toBeVisible()
    await capture(page, `settings-runtime-default-${theme}`)
    await page.getByRole('navigation', { name: 'Settings navigation' }).getByRole('button', { name: 'Runtimes', exact: true }).click()
    await settings.getByRole('button', { name: /^Beta/ }).first().click()
    const use = settings.getByRole('button', { name: 'Use for new sessions', exact: true })
    await expect(use).toBeVisible()
    await capture(page, `settings-runtime-action-${theme}`)
    await use.click()
    await expect(settings.locator('[data-slot="chip"]').filter({ hasText: /^Default$/ })).toBeVisible()
    await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
  })

  test(`Agents retained dialogs close and primary footer actions stay rightmost in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=agents', theme)
    const agents = page.locator('[data-page-destination="agents"]:visible')
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await agents.getByRole('button', { name: 'New Agent…', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'New Agent', exact: true })
    await primaryRightmost(dialog, 'Copy and open')
    await dialog.getByRole('radio', { name: /^A blank Agent/ }).click()
    await primaryRightmost(dialog, 'Create')
    await capture(page, `agents-new-${theme}`)
    await page.keyboard.press('Meta+w')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(agents).toHaveCount(0)
    await page.keyboard.press('Meta+[')
    await expect(agents).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await agents.getByRole('button', { name: /^Implementer/ }).click()
    await bar.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Customize…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Customize Implementer', exact: true })
    await primaryRightmost(dialog, 'Copy and open')
    await capture(page, `agents-customize-${theme}`)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await agents.getByRole('button', { name: 'Add a seat…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'A seat for Implementer on this Mac', exact: true })
    await primaryRightmost(dialog, 'Add seat')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    await openFrame(page, 'frame-wall=agents&frame-detail=agent', theme)
    await agents.locator('section[aria-label="Identity"]').getByRole('button', { name: 'Edit…', exact: true }).first().click()
    dialog = page.getByRole('dialog', { name: 'Edit Name', exact: true })
    await primaryRightmost(dialog, 'Save')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await agents.locator('section[aria-label="Seats"] button').filter({ hasText: /^Edit…$/ }).click()
    dialog = page.getByRole('dialog', { name: 'Edit Seats for Code reviewer', exact: true })
    await primaryRightmost(dialog, 'Save')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await agents.locator('[data-slot="summary-item"]').filter({ hasText: /^Skills/ }).getByRole('button', { name: 'Edit…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Edit Code reviewer’s allowlists', exact: true })
    await primaryRightmost(dialog, 'Save')
    await page.keyboard.press('Meta+w')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
}
