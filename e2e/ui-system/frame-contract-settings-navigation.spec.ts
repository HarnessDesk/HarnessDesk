import { expectSettingsChrome } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()


test('R10 nav4 Settings Back and Meta bracket leave in one step while Forward is ignored there', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  const column = page.locator('[data-left-column]:visible')
  await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.locator('[data-page-destination="settings"]:visible')
  const nav = page.getByRole('navigation', { name: 'Settings navigation' })
  await expect(settings).toHaveCount(1)
  await nav.getByRole('button', { name: 'General', exact: true }).click()
  await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
  await nav.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await page.keyboard.press('Meta+]')
  await expect(nav.getByRole('button', { name: 'Runtimes', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Meta+[')
  await expect(settings).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
  await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
  const reopened = page.getByRole('navigation', { name: 'Settings navigation' })
  await reopened.getByRole('button', { name: 'General', exact: true }).click()
  await reopened.getByRole('button', { name: 'Appearance', exact: true }).click()
  await reopened.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await nav.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
})

for (const theme of WALL_THEMES) {
  test(`D5 preference groups and search in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-middle', theme)
    const nav = page.locator('[data-left-settings]')
    const labels = await nav.locator('[data-left-group-text]').allTextContents()
    expect(labels).toEqual(['Preferences', 'Conversations', 'Runtimes', 'Access'])
    for (const row of await nav.locator('[data-left-row]').all()) {
      expect((await row.boundingBox())!.height).toBe(FRAME.rail.settingsRowHeight)
    }
    await expect(nav.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Library', exact: true })).toHaveCount(0)
    await expect(nav.getByRole('button', { name: 'Plugins', exact: true })).toHaveCount(0)
    await nav.getByRole('searchbox', { name: 'Search settings' }).fill('mute')
    await expect(nav.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'General', exact: true })).toHaveCount(0)
    await nav.getByRole('searchbox', { name: 'Search settings' }).fill('zzzz')
    await expect(nav).toContainText('Nothing in settings matches')
  })
}


for (const theme of WALL_THEMES) {
  test(`D5 controlled keyboard, Back and full search field in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-middle', theme)
    const nav = page.locator('[data-left-settings]')
    const back = nav.getByRole('button', { name: 'Back', exact: true })
    const general = nav.getByRole('button', { name: 'General', exact: true })
    const appearance = nav.getByRole('button', { name: 'Appearance', exact: true })
    await expect(general).toHaveAttribute('aria-current', 'page')
    await back.focus()
    await page.keyboard.press('ArrowDown')
    await expect(general).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(appearance).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(appearance).toHaveAttribute('aria-current', 'page')
    await back.focus()
    await page.keyboard.press('Enter')
    await expect(general).toHaveAttribute('aria-current', 'page')
    const search = nav.getByRole('searchbox', { name: 'Search settings' })
    await search.focus()
    await page.keyboard.press('ArrowDown')
    await expect(search).toBeFocused()
    const field = (await nav.locator('[data-slot="search"]').boundingBox())!
    const middle = (await nav.boundingBox())!
    expect(field.x).toBe(middle.x)
    expect(field.width).toBe(middle.width)
    await search.fill('no matching preference with a deliberately long search phrase')
    const empty = await nav.locator('p').evaluate(node => ({
      height: node.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(node).lineHeight),
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }))
    expect(empty.height).toBeGreaterThan(empty.line)
    expect(empty.scroll).toBeLessThanOrEqual(empty.width)
  })
}
for (const theme of WALL_THEMES) {
  test(`D6a owner top order and seat bell in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const column = page.locator('[data-left-column]:visible')
    expect((await column.boundingBox())!.width).toBe(FRAME.sidebar.width)
    const top = column.locator('[data-left-top]')
    expect(await top.locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
      .toEqual(['Hide sidebar', 'Search everything', 'Back', 'Forward', 'Conversation mode', 'Editor mode'])
    await expect(top.locator('[data-slot="inbox-button"]')).toHaveCount(0)
    const seat = column.locator('[data-left-seat]')
    const bell = seat.locator('[data-slot="inbox-button"]').locator('..')
    await expect(bell).toBeVisible()
    expect((await bell.boundingBox())!.width).toBe(FRAME.bar.iconButton)
    expect((await bell.boundingBox())!.height).toBe(FRAME.bar.iconButton)
    const gear = seat.getByRole('button', { name: 'Settings', exact: true })
    expect((await gear.boundingBox())!.x).toBeGreaterThan((await bell.boundingBox())!.x)
    await bell.click()
    await expect(page.getByRole('dialog', { name: 'Inbox', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
  })
}

test('D6 active Settings column owns the gear and keyboard focus', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings', 'light')
  const modal = page.locator('[data-slot="fixed-shell"]:visible')
  const column = modal.locator('[data-left-column]:visible')
  await expect(column).toHaveCount(1)
  await expect(column.locator('[data-left-seat] button[aria-label="Settings"]')).toHaveAttribute('aria-pressed', 'true')
  await column.getByRole('button', { name: 'Appearance', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(column.getByRole('button', { name: 'Notifications', exact: true })).toBeFocused()
  await expect(page.locator('[data-frame-region="left"] [data-left-column]:visible')).toHaveCount(1)
  await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
})

for (const theme of WALL_THEMES) {
  for (const width of [1440, 1100, 720]) {
    test(`D6 Settings is a visible aligned mode at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=settings-navigation', theme, width)
      const modal = page.locator('[data-slot="fixed-shell"]:visible')
      let column = modal.locator('[data-left-column]:visible')
      if (await column.count() === 0) {
        await modal.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      }
      column = modal.locator('[data-left-column]:visible')
      await expect(column).toHaveCount(1)
      const top = column.locator('[data-left-top] [data-slot="bar"]')
      const main = modal.locator('[data-frame-region="top"]')
      const topBox = (await top.boundingBox())!, mainBox = (await main.boundingBox())!
      expect(topBox.height).toBe(FRAME.bar.height)
      expect(Math.abs(topBox.y + topBox.height - mainBox.y - mainBox.height)).toBeLessThanOrEqual(1)
      const seatBox = (await column.locator('[data-left-seat]').locator('..').boundingBox())!
      await expect(modal.locator('[data-slot="status-bar"], [data-shell-host="status"]')).toHaveCount(0)
      const windowBox = (await modal.boundingBox())!
      expect(seatBox.height).toBe(FRAME.sidebar.footerHeight)
      expect(Math.abs(seatBox.y + seatBox.height - windowBox.y - windowBox.height)).toBeLessThanOrEqual(1)
      await expect(column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }))
        .toHaveAttribute('aria-pressed', 'true')
      const values = await column.locator('[data-left-row]:visible').evaluateAll(nodes => nodes.map(node => {
        const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
        return { height: button.getBoundingClientRect().height,
          icon: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().x,
          text: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!.getBoundingClientRect().x }
      }))
      expect(values.length).toBeGreaterThan(10)
      await expect(column.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0)
      await expect(column.locator('[aria-label="Main sections"]:visible')).toHaveCount(0)
      for (const row of values) expect(row.height).toBe(FRAME.rail.settingsRowHeight)
      for (const edge of ['text', 'icon'] as const) {
        const xs = values.map(row => row[edge])
        expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
      }
      await column.getByRole('searchbox', { name: 'Search settings' }).fill('mute')
      await expect(column.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
      await expect(column.getByRole('button', { name: 'General', exact: true })).toHaveCount(0)
      await column.getByRole('searchbox', { name: 'Search settings' }).fill('')
      await column.getByRole('button', { name: 'Appearance', exact: true }).click()
      if (width < FRAME.fold.sidebarFloats) {
        await expect(column).toHaveCount(0)
        await modal.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      }
      await expect(column.getByRole('button', { name: 'Appearance', exact: true })).toHaveAttribute('aria-current', 'page')
      await column.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(column.getByRole('button', { name: 'Appearance', exact: true })).toHaveAttribute('aria-current', 'page')
      await column.locator('[data-left-settings]').getByRole('button', { name: 'Back', exact: true }).click()
      await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
      await expect(page.locator('[data-slot="fixed-shell"]:visible')).toHaveCount(1)
    })
  }
  for (const destination of ['library', 'plugins']) {
    test(`D6 ${destination} keeps its Sessions door in ${theme}`, async ({ page }) => {
      await openFrame(page, `frame-wall=${destination}`, theme)
      const column = page.locator('[data-slot="fixed-shell"]:visible [data-left-column]:visible')
      const label = destination === 'library' ? 'Library' : 'Plugins'
      await expect(column.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }))
        .toHaveAttribute('aria-pressed', 'false')
      await expect(column.locator('[data-left-settings]:visible')).toHaveCount(0)
    })
  }
}
test('D6 Escape closes the Settings float before the window and restores its lead focus', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings-navigation', 'light', 720)
  const modal = page.locator('[data-slot="fixed-shell"]:visible')
  const show = modal.getByRole('button', { name: 'Show sidebar', exact: true })
  await show.click()
  const column = modal.locator('[data-left-column]:visible')
  await expect(column).toHaveCount(1)
  const back = column.locator('[data-left-settings]').getByRole('button', { name: 'Back', exact: true })
  await back.focus()
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(1)
  await expect(modal.locator('[data-left-column]:visible')).toHaveCount(0)
  await expect(show).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
  await expect(modal).toHaveCount(1)
})
test('D6 float keeps portalled account actions and traps its boundary', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings-navigation', 'light', 720)
  const modal = page.locator('[data-slot="fixed-shell"]:visible')
  const show = modal.getByRole('button', { name: 'Show sidebar', exact: true })
  await show.click()
  const column = modal.locator('[data-left-column]:visible')
  const hide = column.getByRole('button', { name: 'Hide sidebar', exact: true })
  const gear = column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true })
  await gear.focus(); await page.keyboard.press('Tab'); await expect(hide).toBeFocused()
  await page.keyboard.press('Shift+Tab'); await expect(gear).toBeFocused()
  await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
  await page.getByRole('menuitem').and(page.locator('[title="Your name and picture. Nothing syncs between machines."]')).click()
  await expect(column).toHaveCount(0)
  await expect(modal.locator('input[aria-label="Your name"]')).toBeVisible()
  await show.click()
  await expect(column).toBeVisible()
  await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
  await page.keyboard.press('Escape')
  await expect(column).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(column).toBeHidden(); await expect(show).toBeFocused()
  await show.click()
  await modal.locator('[data-slot="workbench-scrim"]').click({ position: { x: 500, y: 150 } })
  await expect(column).toBeHidden(); await expect(modal).toBeVisible()
})

for (const theme of WALL_THEMES) {
  test(`D8 Settings page title is in the content with no title in the bar in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-general', theme)
    await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
    const title = page.locator('[data-page-destination="settings"]:visible').getByRole('heading', { name: 'General', exact: true, level: 1 })
    await expect(title).toBeVisible()
    await expect(title).toHaveAttribute('data-role', 'page')
    await expectSettingsChrome(page, 1440)
  })
}
