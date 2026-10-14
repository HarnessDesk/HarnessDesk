import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()


// D2's standalone column proof; the shell-bottom/fold integration waits for B.
for (const theme of WALL_THEMES) {
  test(`D2 left header, page doors and seat in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const column = page.locator('[data-left-column]:visible')
    const top = column.locator('[data-left-top]')
    await expect(top.locator('[data-slot="bar"]')).toHaveCount(1)
    expect((await top.boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(top.locator('[data-role="wordmark"]')).toHaveCount(0)
    await expect(top.locator('[data-work-panel-toggle]')).toHaveCount(0)
    const rows = column.locator('[aria-label="Main sections"] [data-left-row]')
    await expect(rows).toHaveCount(5)
    const anatomy = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
      const css = getComputedStyle(button)
      return { name: button.getAttribute('aria-label'), height: button.getBoundingClientRect().height,
        size: parseFloat(css.fontSize), slots: node.querySelectorAll('[data-left-trailing]').length }
    }))
    expect(anatomy.map(row => row.name)).toEqual(['Teams', 'Agents', 'Library', 'Plugins', 'Dashboard'])
    for (const row of anatomy) {
      expect(row.height).toBe(FRAME.rail.rowHeight)
      expect(row.size).toBe(FRAME.rail.label)
      expect(row.slots).toBe(1)
    }
    const seat = column.locator('[data-left-seat]')
    expect((await seat.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(seat.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-pressed', 'false')
    const start = column.getByRole('button', { name: 'New session', exact: true })
    await expect(start.locator('..').locator('[data-left-trailing] button')).toHaveCount(1)
  })
}


for (const theme of WALL_THEMES) {
  test(`D2 existing Settings rail shares row and group anatomy in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings', theme)
    const nav = page.getByRole('navigation', { name: 'Settings navigation' })
    const group = nav.locator('[data-left-group]').first()
    const rows = group.locator('[data-left-row]')
    await expect(rows).toHaveCount(4)
    const anatomy = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector('[data-slot="sidebar-menu-button"]')!
      const icon = button.querySelector('[data-slot="sidebar-menu-icon"]')!
      const css = getComputedStyle(button)
      return { height: button.getBoundingClientRect().height, icon: icon.getBoundingClientRect().width,
        iconX: icon.getBoundingClientRect().x, size: parseFloat(css.fontSize) }
    }))
    for (const row of anatomy) {
      expect(row.height).toBe(FRAME.rail.rowHeight)
      expect(row.icon).toBe(FRAME.rail.icon)
      expect(row.size).toBe(FRAME.rail.settingsLabel)
    }
    const ink = await group.locator('[data-left-group-text]').boundingBox()
    expect(ink!.x).toBe(anatomy[0]!.iconX)
    const general = rows.first().getByRole('button')
    await expect(general).toHaveAttribute('aria-current', 'page')
    await general.focus()
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1).getByRole('button')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(rows.nth(1).getByRole('button')).toHaveAttribute('aria-current', 'page')
    await nav.getByRole('searchbox', { name: 'Search settings' }).fill('keyboard')
    await expect(nav.locator('[data-left-group] [data-left-row]')).toHaveCount(1)
    await expect(nav.getByRole('button', { name: 'Keyboard shortcuts', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
  })
}

for (const theme of WALL_THEMES) {
  test(`D3 Teams are single rows in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work', theme)
    const team = page.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    await expect(team).toBeVisible()
    expect((await team.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await expect(team.locator('..').locator('[data-left-trailing]')).toHaveCount(1)
    await expect(page.locator('[data-left-column] [data-nested="true"]')).toHaveCount(0)
    await expect(page.locator('[data-left-column] [aria-label*="agents in"]')).toHaveCount(0)
    await team.click()
    await expect(team).toHaveAttribute('aria-current', 'page')
  })
}

for (const theme of WALL_THEMES) {
  test(`D7 Settings opened from the work float restores its own lead in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, 720)
    await page.locator('[data-slot="top-bar"]').getByRole('button', { name: 'Show sidebar', exact: true }).click()
    await page.locator('[data-left-column]:visible [data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
    const modal = page.locator('[data-slot="fixed-shell"]:visible')
    await modal.getByRole('button', { name: 'Show sidebar', exact: true }).click()
    const column = modal.locator('[data-left-column]:visible')
    await expect(column).toBeVisible()
    await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="menu"]')).toHaveCount(0)
    await expect(column).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(column).toBeHidden()
    await expect(modal.getByRole('button', { name: 'Show sidebar', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
    await expect(modal).toHaveCount(1)
  })
}

test('D8 Search stays in the window top row when the column is hidden', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-sidebar-hidden=1', 'light')
  await expect(page.locator('[data-left-column]:visible')).toHaveCount(0)
  const top = page.locator('[data-slot="top-bar"]:visible').first()
  await expect(top.getByRole('button', { name: 'Search everything', exact: true })).toBeVisible()
})
