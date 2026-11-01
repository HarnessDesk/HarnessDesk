import { closeFloatingTeamRail } from './team-frame-actions'
import { openWallDestination } from './frame-wall-actions'
import { expect, test } from '@playwright/test'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame, expectMenuGeometry, expectInfoGeometry } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C7 info card hover and focus at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=info', theme, width)
    const trigger = page.getByRole('button', { name: 'Storefront catalogue review', exact: true })
    await trigger.hover()
    const card = page.locator('[data-popup-kind="info-card"]:visible').last()
    await expectInfoGeometry(card)
    await page.mouse.move(0, 0)
    await expect(card).toBeHidden()
    await page.keyboard.press('Tab')
    await trigger.focus()
    await expectInfoGeometry(card)
  })
  test(`C7 menu cancels a pending facts card at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=info-and-menu', theme, width)
    await page.getByRole('button', { name: 'Storefront catalogue review', exact: true }).hover()
    await page.getByRole('button', { name: 'Frame menu', exact: true }).click()
    await expect(page.locator('[data-popup-kind="menu"]:visible')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    await expect(page.locator('[data-popup-kind="menu"]:visible')).toBeVisible()
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-popup-kind="menu"]')).toHaveCount(0)
    const facts = page.getByRole('button', { name: 'Storefront catalogue review', exact: true })
    await facts.focus()
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(1)
    await page.getByRole('button', { name: 'Frame menu', exact: true }).click()
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-popup-kind="menu"]')).toHaveCount(0)
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    await facts.focus()
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(1)
  })
}

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) for (const source of ['context', 'member', 'budget']) {
  test(`C8 production ${source} info adapter at ${width} in ${theme}`, async ({ page }) => {
    const query = source === 'context' ? 'frame-wall=conversation' : `frame-wall=conversation&popup=${source}-info`
    await openFrame(page, query, theme, width)
    if (source === 'context') await closeFloatingTeamRail(page.locator('body'))
    const trigger = source === 'budget' ? page.getByRole('button', { name: 'Run budget', exact: true }) : page.locator(`[data-info-source="${source}"]`).first()
    await trigger.hover()
    await expectInfoGeometry(page.locator('[data-popup-kind="info-card"]:visible').last())
  })
}

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C6 account menu switches without a destructive row at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    await openWallDestination(page, { account: true })
    await expectMenuGeometry(page.locator('[data-popup-kind="wide-menu"]:visible').last())
    await expect(page.locator('[data-popup-kind="info-card"]:visible')).toHaveCount(0)
    // Signing out of an agent account is on that account's page in Settings.
    await expect(page.getByRole('menuitem', { name: /^Sign out of (?!HarnessDesk)/ })).toHaveCount(0)
  })
}

for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C10 inbox retains expanded facts and actions at ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=inbox', theme, width)
    await page.getByRole('button', { name: 'Inbox, 1 unread', exact: true }).click()
    const plate = page.locator('[data-popup-kind="wide-menu"]:visible')
    await expectMenuGeometry(plate)
    await page.getByRole('menuitem', { name: /The Storefront catalogue compatibility check/ }).click()
    await expect(plate).toContainText('workspace/storefront/project.config.json')
    await expect(plate).toContainText('tools.search.timeout')
    await expect(page.getByRole('menuitem', { name: 'Open the findings', exact: true })).toBeVisible()
    await expectMenuGeometry(plate)
    await page.getByRole('menuitem', { name: 'Open the findings', exact: true }).click()
    await expect(plate).toBeHidden()
  })
}
