import { expect, test, type Page } from '@playwright/test'
import { PAGE_WALL_DESTINATIONS } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'
import { selectFrameTab } from './frame-actions'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()

const openDestination = async (page: Page, kind: string): Promise<void> => {
  const label = kind === 'library' || kind === 'plugins' ? 'Customize' : kind[0]!.toUpperCase() + kind.slice(1)
  await page.locator('[data-left-column]:visible').getByRole('button', { name: label, exact: true }).click()
  if (kind === 'library') await selectFrameTab(page, 'skill')
  else if (kind === 'plugins') await page.getByRole('radiogroup', { name: 'Customize sections', exact: true }).getByRole('radio', { name: 'Plugins', exact: true }).click()
}


// The retired window stopgap survives as navigation behavior on actual pages.
for (const kind of ['settings', 'dashboard', 'agents', 'teams', 'library', 'plugins', 'changes-review']) {
  {
    for (const chord of ['Meta+n', 'Meta+Shift+n']) {
      test(`E9 owner page ${kind} leaves main through new-work shortcuts: ${chord}`, async ({ page }) => {
        const open = async () => {
          await openFrame(page, 'frame-wall=navigation&frame-review=1', 'light')
          if (kind === 'changes-review') await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:review')))
          else await openDestination(page, kind)
          await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
        }
        await open()
        await page.keyboard.press(chord)
        if (chord === 'Meta+Shift+n') {
          await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
          await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
        } else {
          await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(0)
          await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
        }
      })
    }
  }
  if (kind !== 'settings') {
    for (const label of ['Teams', 'Agents', 'Customize', 'Customize · Plugins', 'Dashboard', 'Settings', 'New session', 'conversation']) {
      const target = label === 'Customize' ? 'library' : label === 'Customize · Plugins' ? 'plugins' : label.toLowerCase()
      if (target === kind) continue;
      test(`E9 owner page ${kind} every column door and work row navigates: ${label}`, async ({ page }) => {


        await openFrame(page, 'frame-wall=navigation&frame-review=1', 'light')
        const column = page.locator('[data-left-column]:visible')
        if (kind === 'changes-review') await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:review')))
        else await openDestination(page, kind)
        await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
        if (label === 'conversation') await column.locator('[data-region="session-row"] [data-slot="sidebar-menu-button"]').first().click()
        else if (label === 'New session') await column.getByRole('button', { name: label, exact: true }).click()
        else await openDestination(page, target)
        await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(0)
        if (label === 'conversation' || label === 'New session') await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
        else await expect(page.locator(`[data-page-destination="${target}"]:visible`)).toHaveCount(1)
      })
    }
  }
}

// E9: the More door exists only while its destination has at least one row.
test(`E9 every destination More either stays absent or opens rows, and returns for actions: Dashboard-to-Customize journey`, async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  const column = page.locator('[data-left-column]:visible')
  const more = page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button')
  await column.getByRole('button', { name: 'Dashboard', exact: true }).click()
  await expect(page.locator('[data-page-destination="dashboard"]:visible')).toHaveCount(1)
  await expect(more).toBeVisible()
  await more.click()
  await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await openDestination(page, 'library')
  await expect(page.locator('[data-page-destination="library"]:visible')).toHaveCount(1)
  await expect(more).toBeVisible()
  await more.click()
  await expect(page.getByRole('menu').locator('[role^="menuitem"], [role="switch"]')).toHaveText(['Check for updates', 'Rescan', 'Changes made here…', /Terminal/])
  await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(1)
})
{
  const routes = [...new Set(PAGE_WALL_DESTINATIONS.map(destination => destination.query))]
  for (const [item, query] of routes.entries()) test(`E9 every destination More either stays absent or opens rows, and returns for actions: route ${item}`, async ({ page }) => {
    await openFrame(page, query, 'light')
    const trigger = page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button')
    if (await trigger.count()) {
      await trigger.click()
      const rows = page.getByRole('menu').locator('[role^="menuitem"], [role="switch"]')
      expect(await rows.count(), `${query} opens a menu with at least one row`).toBeGreaterThan(0)
    }
  })
}

// R10 nav4 owns these round-four navigation and Changes review contracts.
test('R10 nav4 New Team keeps the Teams page behind the dialog from the body', async ({ page }) => {
  await openFrame(page, 'frame-wall=teams', 'light')
  await page.locator('[data-slot="teams-board-toolbar"]').getByRole('button', { name: 'New Team', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('[data-page-destination="teams"]:visible')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('[data-page-destination="teams"]:visible')).toHaveCount(1)
})

test('R10 nav4 New Team keeps the empty Teams page behind the dialog', async ({ page }) => {
  await openFrame(page, 'frame-wall=teams&frame-empty=1', 'light')
  const teams = page.locator('[data-page-destination="teams"]:visible')
  await teams.locator('[data-slot="teams-board-toolbar"]').getByRole('button', { name: 'New Team', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(teams).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(teams).toHaveCount(1)
})

test('R10 nav4 opening the fourth storefront conversation keeps project recency order', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation&frame-recency=1', 'light')
  const project = page.locator('[data-left-column]:visible [data-project-root="/work/storefront"]')
  await expect(project).toBeVisible()
  const rows = project.locator('[data-region="session-row"]')
  await expect(rows).toHaveCount(4)
  const labels = async () => rows.evaluateAll(elements => elements.map(element => element.querySelector('[data-left-row] > button')?.getAttribute('aria-label')))
  const before = await labels()
  expect(before).toEqual([
    'Review the checkout plan', 'Inspect basket validation', 'Adjust retry handling', 'Check payment edge cases',
  ])
  const fourth = rows.nth(3).locator('[data-left-row] > button')
  await fourth.click()
  await expect(fourth).toHaveAttribute('aria-current', 'page')
  expect(await labels()).toEqual(before)
})

for (const kind of ['library', 'plugins', 'dashboard']) test(`E9 owner Escape leaves the former ${kind} window destination`, async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  await openDestination(page, kind)
  await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
  const more = page.locator('[data-slot="top-bar"]:visible [data-topbar="more"] button')
  if (kind === 'library') {
    await expect(more).toBeVisible()
    await more.click()
    await page.keyboard.press('Escape')
    await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
    await expect(page.locator('[role="menu"]:visible')).toHaveCount(0)
    await page.getByRole('button', { name: 'Add skill', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Copy from another runtime…', exact: true }).click()
  } else {
    await more.click()
    await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="menu"]:visible')).toHaveCount(0)
    await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
  }
  if (kind === 'library' || kind === 'plugins') {
    if (kind === 'plugins') await page.getByRole('button', { name: 'Add plugin', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
})
