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
    expect(anatomy.map(row => row.name)).toEqual(['Teams', 'Flows', 'Agents', 'Customize', 'Dashboard'])
    for (const row of anatomy) {
      expect(row.height).toBe(FRAME.rail.rowHeight)
      expect(row.size).toBe(FRAME.rail.label)
      expect(row.slots).toBe(1)
    }
    const seat = column.locator('[data-left-seat]')
    expect((await seat.locator('..').boundingBox())!.height).toBe(FRAME.sidebar.footerHeight)
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
      expect(row.height).toBe(FRAME.rail.settingsRowHeight)
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
  test(`D3 Teams keep one parent row and fold Seats after their name in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work', theme)
    const team = page.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    await expect(team).toBeVisible()
    expect((await team.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await expect(team.locator('..').locator('[data-left-trailing]')).toHaveCount(1)
    await expect(page.locator('[data-left-column] [data-nested="true"]')).toHaveCount(1)
    const seats = team.locator('xpath=ancestor::*[@data-region="team-row"]').locator('[data-region="seat-row"]')
    await expect(seats).toHaveCount(3)
    for (const seat of await seats.locator('[data-slot="sidebar-menu-button"]').all()) expect((await seat.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    const fold = team.locator('..').locator('[data-left-disclosure]')
    await expect(fold).toHaveCount(1)
    const name = (await team.locator('[data-left-fold-name]').boundingBox())!
    await team.hover({ position: { x: 8, y: 16 } })
    const arrow = (await fold.locator('[data-slot="disclosure-chevron"]').boundingBox())!
    expect(Math.abs(arrow.x - name.x - name.width - 6)).toBeLessThanOrEqual(1)
    await expect(team).toHaveAttribute('aria-expanded', 'true')
    await fold.click()
    await expect(team).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-left-column] [data-left-nested]')).toHaveCount(0)
    await team.click({ position: { x: 8, y: 16 } })
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

test('D8 the hidden-column lead restores the column that owns Search', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-sidebar-hidden=1', 'light')
  await expect(page.locator('[data-left-column]:visible')).toHaveCount(0)
  const top = page.locator('[data-slot="top-bar"]:visible').first()
  await expect(top.getByRole('button', { name: 'Search everything', exact: true })).toHaveCount(0)
  await top.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await expect(page.locator('[data-left-column]:visible').getByRole('button', { name: 'Search everything', exact: true })).toBeVisible()
})

for (const theme of WALL_THEMES) test(`original edges for navigation, work, footer and Settings in ${theme}`, async ({ page }) => {
  // Keep a second synthetic index page available so the real load-more row renders.
  await page.route('**/src/preview/frame-destination-store.ts*', async route => {
    const response = await route.fetch()
    const body = (await response.text()).replaceAll('query.pageSize ?? 50', '7')
    await route.fulfill({ response, body })
  })
  await openFrame(page, 'frame-wall=left-work&frame-update=1', theme)
  const column = page.locator('[data-left-column]:visible')
  const account = column.locator('button[class*="accountRow"]')
  const rows = {
    navigation: column.getByRole('button', { name: 'Teams', exact: true }),
    loose: column.getByRole('button', { name: 'Release notes', exact: true }),
    team: column.getByRole('button', { name: 'Room Ship checkout retry', exact: true }),
    loadMore: column.getByRole('button', { name: 'Load more conversations', exact: true }),
    update: column.getByRole('button', { name: 'Relaunch to update', exact: true }),
  }
  const measure = (row: typeof account) => row.evaluate(node => {
    const origin = node.closest('[data-left-column]')!.getBoundingClientRect().x
    const icon = node.querySelector('[data-slot="sidebar-menu-icon"], [data-shape="face"]')!
    const label = node.querySelector('[data-slot="sidebar-menu-label-content"], [class*="accountName"]')!
    return { icon: icon.getBoundingClientRect().x - origin, label: label.getBoundingClientRect().x - origin }
  })
  const measurements: Record<string, { icon: number; label: number }> = {}
  for (const [kind, row] of Object.entries({ ...rows, account })) {
    await expect(row).toBeVisible()
    measurements[kind] = await measure(row)
  }
  console.log(JSON.stringify({ theme, leftColumn: measurements }))
  for (const [kind, row] of Object.entries(measurements)) {
    if (kind === 'account') continue
    expect(Math.abs(row.icon - measurements.navigation!.icon)).toBeLessThanOrEqual(1)
    expect(Math.abs(row.label - measurements.navigation!.label)).toBeLessThanOrEqual(1)
  }

  // The account retains its original bordered 24px face and 6px label gap.
  expect(measurements.account!.icon).toBe(17)
  expect(measurements.account!.label).toBe(47)
  await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.locator('[data-left-column]:visible').last()
  const general = settings.getByRole('button', { name: 'General', exact: true })
  await expect(general).toBeVisible()
  const settingsX = await measure(general)
  console.log(JSON.stringify({ theme, settings: settingsX }))
  expect(Math.abs(settingsX.icon - measurements.navigation!.icon)).toBeLessThanOrEqual(1)
  expect(Math.abs(settingsX.label - measurements.navigation!.label - 4)).toBeLessThanOrEqual(1)

})
