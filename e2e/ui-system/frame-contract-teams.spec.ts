import { measureDestination, expectPageJourney } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { selectFrameTab } from './frame-actions'
import { openFrame } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })



// The shared preview replacement belongs to Task 9. Route only this lane's
// Teams fixture module through the existing preview document; all UI/store code is real.


for (const width of [1440, 720]) test(`E5 Teams journey keeps the normal column and history ${width}`, async ({ page }) => {
  await expectPageJourney(page, 'Teams', 'teams', width)
  const column = page.locator('[data-left-column]:visible')
  const reveal = async () => { if (width === 720) { const sidebar = page.getByRole('dialog', { name: 'Sidebar', exact: true }); if (await sidebar.isVisible()) return; const show = page.getByRole('button', { name: 'Show sidebar', exact: true }); await expect(show).toBeVisible(); await show.click(); await expect(sidebar).toBeVisible() } }
  const back = async () => { await reveal(); const settingsNav = page.getByRole('navigation', { name: 'Settings navigation' }); if (await settingsNav.isVisible()) await settingsNav.getByRole('button', { name: 'Back', exact: true }).click(); else await page.locator('[data-left-column]:visible [data-left-top]').getByRole('button', { name: 'Back', exact: true }).click(); await expect(page.locator('[data-page-destination="teams"]:visible')).toHaveCount(1); await reveal() }
  await column.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible(); await back()
  await column.locator('[data-region="session-row"] [data-slot="sidebar-menu-button"]').first().click()
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible(); await back()
  await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1); await back()
})
test('E5 Teams column background reaches the window top', async ({ page }) => {

  await openFrame(page, 'frame-wall=teams', 'light')
  const legacy = page.locator('[data-slot="app-window"]:visible [data-slot="app-window-nav"]')
  const column = await legacy.count() ? legacy : page.locator('[data-left-column]:visible')
  await expect(column).toBeVisible()
  expect((await column.boundingBox())!.y).toBe(0)
  const colors = await column.evaluate(node => {
    const paint = (el: Element): string => { const color = getComputedStyle(el).backgroundColor; return color === 'rgba(0, 0, 0, 0)' && el.parentElement ? paint(el.parentElement) : color }
    const expected = document.createElement('div'); expected.style.background = 'var(--hd-sidebar)'; node.append(expected)
    const actual = paint(node), top = paint(node.querySelector('[data-left-top]') ?? node), want = getComputedStyle(expected).backgroundColor; expected.remove()
    return [actual, top, want]
  })
  expect(colors.slice(0, 2)).toEqual([colors[2], colors[2]])
})
{

  for (const [item0, query] of (['frame-wall=teams', 'frame-wall=teams&frame-no-folder=1']).entries()) test(`E5 Teams offers a useful More menu with or without a folder [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, query, 'light')
    await page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button').click()
    await expect(page.getByRole('menuitem',{name:'Refresh Teams',exact:true})).toBeVisible()


  })
}

for (const theme of ['light', 'dark'] as const) for (const width of [2200, 1440, 1100, 720]) {
  for (const filter of ['active', 'needs-you', 'settled']) test(`E5 Teams ${filter} ${width} ${theme}`, async ({ page }) => {

    await measureDestination(page, `frame-wall=teams&frame-filter=${filter}`, 'wide', theme, width)
    const bar=page.locator('[data-slot="top-bar"]:visible')
    await expect(bar.getByRole('button', {name:'New Team',exact:true})).toHaveCount(0)
    await expect(bar.locator('[role="tab"]')).toHaveCount(0)
    const body=page.locator('[data-page-destination="teams"]:visible')
    await expect(body.locator('[data-slot="teams-board-toolbar"]').getByRole('button',{name:'New Team',exact:true})).toBeVisible()
    await expect(body.locator('[data-slot="teams-board-column"]')).toHaveCount(3)
    await expect(body.locator('[data-team-row]')).toHaveCount(5)
    await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
  })
}
for (const theme of ['light', 'dark'] as const) test(`E5 Teams empty state uses the shared main block ${theme}`, async ({ page }) => {

  await openFrame(page, 'frame-wall=teams&frame-empty=1', theme)
  const empty = page.locator('[data-page-destination="teams"]:visible [data-slot="page"] > [data-slot="empty-state"][data-variant="panel"]')
  await expect(empty).toBeVisible()
  await expect(empty.locator('svg')).toHaveCount(1)
  await expect(empty.getByRole('heading', { name: 'No Teams yet', exact: true })).toBeVisible()
  await expect(empty.getByText(/Create a Team/)).toBeVisible()
  await expect(empty.getByRole('button', { name: 'New Team', exact: true })).toBeVisible()
})

test('R10 empty Teams keeps its action content-width and centred', async ({ page }) => {
  await openFrame(page, 'frame-wall=teams&frame-empty=1', 'light', 1440)
  const empty = page.locator('[data-page-destination="teams"]:visible [data-slot="page"] > [data-slot="empty-state"][data-variant="panel"]')
  const action = empty.getByRole('button', { name: 'New Team', exact: true })
  const panel = (await empty.boundingBox())!
  const button = (await action.boundingBox())!
  expect(button.width).toBeLessThan(panel.width - 32)
  expect(button.x + button.width / 2).toBeCloseTo(panel.x + panel.width / 2, 1)
})

test('E5 Team row enters work and keeps room navigation separate from page history', async ({ page }) => {

  await openFrame(page, 'frame-wall=teams', 'dark')
  await page.locator('[data-slot="teams-board"]:visible').getByRole('button', { name: /^Open / }).first().click()
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
  await selectFrameTab(page, 'findings')
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="teams"]')).toBeVisible()
  await page.keyboard.press('Meta+]')
  await expect(page.locator('[data-slot="team-room"]')).toBeVisible()
  await expect(page.locator('[data-team-page="findings"]')).toBeVisible()
})
for (const theme of ['light', 'dark'] as const) test(`E5 Teams body choices survive page history and New Team opens the existing dialog ${theme}`, async ({ page }) => {
  await openFrame(page, 'frame-wall=teams', theme)
  const search=page.getByRole('searchbox',{name:'Search Teams',exact:true})
  await search.fill('invoice')
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
  await page.keyboard.press('Meta+]')
  await expect(search).toHaveValue('invoice')
  await page.locator('[data-slot="teams-board-toolbar"]').getByRole('button',{name:'New Team',exact:true}).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})
test('E5 Teams without a folder refuses New Team', async ({ page }) => {

  await openFrame(page, 'frame-wall=teams&frame-no-folder=1', 'light')
  const create = page.locator('[data-slot="teams-board-toolbar"]').getByRole('button', { name: 'New Team', exact: true })
  await expect(create).toBeDisabled(); await expect(create).toHaveAttribute('title', 'Open a project folder first.')
})
