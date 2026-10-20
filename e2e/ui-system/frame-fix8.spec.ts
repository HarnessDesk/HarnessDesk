import { selectFrameTab } from './frame-actions'
import { expect, test, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'
import { FRAME } from '../../packages/ui/src/design/frame'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })
const openFrame = async (page: Page, query: string, width = 1280, theme: 'light' | 'dark' = 'light') => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => Boolean((window as Window & { __hdFrameWall?: unknown }).__hdFrameWall))
}

{

  for (const [item0, theme] of (['light', 'dark'] as const).entries()) test(`kept conversation opens read-only after runtime failure [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, 'frame-wall=conversation&frame-fix8-kept=1', 1280, theme)
    const row = page.getByRole('button', { name: 'Kept conversation', exact: true })
    await row.click()
    await expect(page.locator('[data-live-transcript]')).toContainText('First kept message')
    await expect(page.locator('textarea:visible')).toHaveCount(0)
    await expect(page.locator('[data-slot="notice-strip"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="composer-dock"]').filter({ hasText: 'Choose a working installation in Settings.' }).last()).toContainText('Choose a working installation in Settings.')
    await expect(page.locator('[data-work-tool="activity"]')).toHaveCount(0)
    await page.locator('[data-topbar-title]').getByRole('button').click()
    const fork = page.getByRole('menuitem', { name: /^Fork/ })
    await expect(fork).toHaveAttribute('aria-disabled', 'true')
    await expect(fork).toHaveAttribute('title', /failed its version check/)


  })
}

{

  for (const [item0, state] of (['failed', 'starting']).entries()) for (const theme of ['light', 'dark'] as const) test(`draft composer keeps its text box and disables Send while the runtime is failed or starting [item ${[item0].join('-')}] ${theme}`, async ({ page }) => {

    await openFrame(page, `frame-wall=draft&frame-fix8-readiness=${state}`, 1280, theme)
    const textarea = page.locator('textarea:visible')
    await expect(textarea).toBeVisible()
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeDisabled()
    await expect(textarea).toBeEnabled()
    await expect(textarea).toHaveAttribute('placeholder', 'Describe a task to start a session — / for commands, @ for files')
    const tools = page.locator('[data-slot="composer-tools"]')
    const readiness = tools.locator(`[data-slot="chip"][data-state="${state === 'failed' ? 'broken' : 'unknown'}"]`)
    await expect(readiness).toBeVisible()
    expect((await tools.locator('[data-composer-track="work-in"]').boundingBox())!.width).toBeGreaterThanOrEqual(24)
    await expect(readiness).toHaveText(state === 'failed' ? 'Unavailable' : 'Not answered yet')
    await textarea.fill('Review the checkout changes.')
    await expect(send).toBeDisabled()
    await expect(send).toHaveAttribute('title', state === 'failed'
      ? 'The agent failed its version check. Choose a working installation in Settings.'
      : 'Waiting for the runtime to start')
    if (process.env.HD_1737_FRAMES) await page.screenshot({ path: `${process.env.HD_1737_FRAMES}/draft-${state}-${theme}.png` })
    if (state === 'failed') {
      await tools.getByRole('button', { name: 'Unavailable', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible()
    }


  })
}

test('column filter keeps a matching conversation across repository worktrees', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-fix8-filter=1')
  await expect(page.getByRole('button', { name: 'Lead', exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Filter this list' }).fill('Lead')
  await expect(page.getByRole('button', { name: 'Lead', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0)
  await expect(page.getByText('No conversations match', { exact: false })).toHaveCount(0)
})

{

  for (const [item0, width] of ([1100, 720]).entries()) for (const [item1, tool] of (['Changes', 'Browser']).entries()) test(`a pane respects the standing boundary and returns main to its exact geometry [item ${[item0, item1].join('-')}]`, async ({ page }) => {

    await openFrame(page, 'frame-wall=conversation', width)
    const main = page.locator('[data-frame-region="main"]')
    const before = await main.boundingBox()
    await page.getByRole('button', { name: tool, exact: true }).first().click()
    const right = page.locator('[data-frame-region="right"]:visible')
    await expect(right).toBeVisible()
    const panel = await right.boundingBox()
    expect(before).not.toBeNull()
    expect(panel!.x + panel!.width).toBe(width)
    expect(panel!.y).toBe(0)
    expect(panel!.height).toBe(900)
    expect(panel!.width).toBeGreaterThanOrEqual(FRAME.rightPanel.min)
    if (width < FRAME.fold.panelFloats) {
      expect(panel!.x).toBe(before!.x)
      expect(panel!.width).toBe(width - before!.x)
      await expect(main).toBeHidden()
    } else {
      const paneWidth = Math.min(FRAME.rightPanel.width, width - before!.x - FRAME.main.min - 2)
      expect(panel!.width).toBe(paneWidth)
      expect(panel!.x).toBe(width - paneWidth)
      await expect(main).toBeVisible()
      const reading = (await main.boundingBox())!
      expect(reading.x).toBe(before!.x)
      expect(reading.x + reading.width).toBe(panel!.x)
      expect(reading.width).toBeGreaterThanOrEqual(FRAME.main.min)
    }
    await page.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect(right).toHaveCount(0)
    await expect(main).toBeVisible()
    await expect.poll(() => main.boundingBox()).toEqual(before)


  })
}

test('dashboard without plan reports explains the absence once', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=overview&frame-empty-usage=1')
  await expect(page.getByText('Nothing is spent or low right now.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('No runtime here reports plan usage.', { exact: true })).toHaveCount(1)
})

test('spend keeps unscanned days as gaps in bars and line beside its coverage', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=spend&frame-fix8-ledger=1')
  const range = page.getByRole('combobox', { name: 'How far back', exact: true })
  await range.selectOption('7')
  const plot = page.locator('[data-slot="day-columns"]').first()
  await expect(plot.locator('li').filter({ hasText: 'No record yet' })).toHaveCount(0)
  await expect(page.locator('[data-slot="chart-head"]').first()).toContainText('4 of 7 days with usage')
  await page.getByRole('combobox', { name: 'Bars or line', exact: true }).selectOption('line')
  await expect(plot.locator('li').filter({ hasText: 'No record yet' })).toHaveCount(0)
})

test('projects empty usage has one message and headings follow the grouping', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=projects&frame-empty-usage=1')
  await expect(page.getByRole('heading', { name: 'Team usage in HarnessDesk', exact: true })).toBeVisible()
  await expect(page.getByText('No Team usage in HarnessDesk in the last 30 days', { exact: true })).toHaveCount(1)
  await expect(page.locator('[data-slot="banner"]')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Project usage view', exact: true }).selectOption('agent')
  await expect(page.getByRole('heading', { name: 'Agent usage in HarnessDesk', exact: true })).toBeVisible()
  await expect(page.getByText('No Team usage in HarnessDesk in the last 30 days', { exact: true })).toHaveCount(1)
})

test('spend selected ranges equal their shorter figures', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=spend&frame-fix8-ledger=1')
  const range = page.getByRole('combobox', { name: 'How far back', exact: true })
  for (const [wide, span] of [[30, 7], [90, 30]]) {
    await range.selectOption(String(wide))
    const stat = page.locator('[data-slot="stat"]').filter({ hasText: `Last ${span} days` })
    const value = await stat.locator('[data-role="metric"]').innerText()
    await range.selectOption(String(span))
    await expect(page.locator('[data-slot="chart-title"][data-figure]').first()).toHaveText(value)
  }
})

test('stopping a waiting Team removes its command approval', async ({ page }) => {
  await openFrame(page, 'frame-wall=team&frame-fix8-stop=1')
  await selectFrameTab(page, 'room')
  await expect(page.locator('[data-slot="room-stream"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await selectFrameTab(page, 'run')
  await page.getByRole('button', { name: 'Stop run…', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop run', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await selectFrameTab(page, 'room')
  await expect(page.locator('[data-slot="room-stream"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Needs you', exact: true })).toHaveCount(0)
  await expect(page.getByRole('banner')).not.toContainText('Needs you')
})

{

  for (const [item0, theme] of (['light', 'dark'] as const).entries()) test(`settled Team Receipt and Findings share the kept finding and count [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, 'frame-wall=team-receipt&frame-fix8-receipt-finding=1', 1280, theme)
    await selectFrameTab(page, 'receipt')
    await expect(page.locator('[data-slot="goal-receipt"]')).toBeVisible()
    await expect(page.getByRole('button', { name: /Missing null check on the checkout path/ })).toBeVisible()
    await selectFrameTab(page, 'findings')
    await expect(page.getByRole('region', { name: 'Findings', exact: true })).toContainText('Missing null check on the checkout path')
    await expect(page.getByText('No findings recorded', { exact: true })).toHaveCount(0)


  })
}

test('command strip waits for approval before saying it is running', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-fix8-command-waiting=1')
  await expect(page.locator('[data-topbar="state"] [aria-label="Waiting for you"]')).toBeVisible()
  await expect(page.getByText('1 command waiting for approval in this turn', { exact: true })).toBeVisible()
  await expect(page.getByText('1 command running in this turn', { exact: true })).toHaveCount(0)
})

{

  for (const [item0, width] of ([1280, 720]).entries()) test(`permission profile is grouped described and selectable at both widths [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, 'frame-wall=draft&frame-fix8-permission-profile=1', width)
    await page.getByRole('button', { name: /Workspace write/ }).last().click()
    const menu = page.getByRole('menu')
    await expect(menu.getByText('Profiles', { exact: true })).toBeVisible()
    const row = menu.getByRole('menuitemradio', { name: 'ci Checks files using the project configuration.', exact: true })
    await expect(row).toHaveAttribute('aria-checked', 'false')
    const box = await row.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    await row.click()
    await page.getByRole('button', { name: 'Permissions — ci' }).click()
    await expect(page.getByRole('menuitemradio', { name: 'ci Checks files using the project configuration.', exact: true })).toHaveAttribute('aria-checked', 'true')


  })
}

{

  for (const [item0, theme] of (['light', 'dark'] as const).entries()) test(`accent leaves selection and on switches neutral in both themes [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, 'frame-wall=settings&frame-section=appearance', 1280, theme)
    await page.getByRole('combobox', { name: 'Interface', exact: true }).selectOption('studio')
    const values = () => page.evaluate(() => {
      const style = getComputedStyle(document.body)
      return ['--hd-toggle-on', '--hd-toggle-knob-on', '--hd-sidebar-selected', '--hd-ring'].map(name => style.getPropertyValue(name).trim())
    })
    await page.getByRole('radio', { name: 'Violet', exact: true }).click()
    await expect(page.locator('body')).toHaveAttribute('data-hd-accent', 'violet')
    const violet = await values()
    await page.getByRole('radio', { name: 'Green', exact: true }).click()
    await expect(page.locator('body')).toHaveAttribute('data-hd-accent', 'green')
    const green = await values()
    expect(green.slice(0, 3)).toEqual(violet.slice(0, 3))
    expect(green[3]).not.toBe(violet[3])
    await expect(page.getByText('Focus rings and primary action highlights.', { exact: true })).toBeVisible()


  })
}

test('palette shows one Agent door and refuses an unavailable explicit start', async ({ page }) => {
  await openFrame(page, 'frame-wall=draft&frame-fix8-palette=1')
  await page.getByRole('button', { name: 'Search everything', exact: true }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await expect(page.getByRole('option', { name: 'Open Unavailable reviewer', exact: true })).toHaveCount(1)
  await expect(page.getByRole('option', { name: /Start as Unavailable reviewer/ })).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search sessions, files, teams, agents, commands…', exact: true }).fill('start as unavailable reviewer')
  const start = page.getByRole('option', { name: 'Start as Unavailable reviewer', exact: true })
  await expect(start).toBeDisabled()
  await expect(start).toHaveAttribute('title', 'It names no seat to try')
  await page.getByRole('searchbox', { name: 'Search sessions, files, teams, agents, commands…', exact: true }).press('Enter')
  await expect(start).toBeVisible()
})
