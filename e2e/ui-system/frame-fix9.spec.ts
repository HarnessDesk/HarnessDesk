import { expect, test, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })
const openFrame = async (page: Page, query: string, width = 1280, theme: 'light' | 'dark' = 'light') => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => Boolean((window as Window & { __hdFrameWall?: unknown }).__hdFrameWall))
}

test('FIX9 kept history remains readable after reopening', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-fix8-kept=1')
  await page.getByRole('button', { name: 'Kept conversation', exact: true }).click()
  await expect(page.locator('[data-live-transcript]')).toContainText('First kept message')
  await expect(page.locator('[data-slot="composer-dock"]:has(> [data-slot="pane-column"][data-inset="bars"])')).toContainText('Choose a working installation in Settings.')
})

test('FIX9 wrapped findings use the receipt and ask nothing of a person', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await openFrame(page, 'frame-wall=team-receipt&frame-fix9-findings=1', 1280, theme)
    await page.getByRole('tab', { name: 'Findings 5', exact: true }).click()
    const pane = page.getByRole('region', { name: 'Findings', exact: true })
    await expect(pane.getByRole('button', { name: /Advisory finding/ })).toHaveCount(4)
    await expect(pane.locator('[aria-label="Findings summary"]')).toContainText('Open4Blocking0All5')
    await expect(pane.locator('[aria-label="This round"]')).toHaveCount(0)
    await expect(pane.getByText('Waiting for a person', { exact: true })).toHaveCount(0)
    await expect(pane).toContainText('The run was stopped before this was posted')
    await expect(pane).not.toContainText('yet')
    await expect(pane).not.toContainText('Goal')
  }
})

test('FIX9 stopped Team keeps its Researcher and explains round counts', async ({ page }) => {
  await openFrame(page, 'frame-wall=team&frame-fix9-stop=1')
  await page.getByRole('tab', { name: 'Run 1', exact: true }).click()
  await page.getByRole('button', { name: 'Stop run…', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop run', exact: true }).click()
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  const agents = page.locator('[data-slot="team-overview"]')
  await expect(agents).not.toContainText('No agents')
  await expect(agents).toContainText('Researcher')
  await expect(agents).toContainText('Stopped')
  await expect(page.locator('[data-slot="team-overview"]')).not.toContainText('Rounds 0 of')
})

test('FIX9 command card waits for approval and names its folder', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-fix9-command-waiting=1')
  const transcript = page.locator('[data-live-transcript]')
  await expect(transcript).toContainText('Waiting for approval · List files in storefront')
  await expect(transcript).not.toContainText('Listed')
  await expect(transcript).not.toContainText('/work/storefront')
})

test('FIX9 empty spend has one statement and coverage once', async ({ page }) => {
  for (const view of ['overview', 'spend']) {
    await openFrame(page, `frame-wall=dashboard&frame-view=${view}&frame-empty-usage=1`)
    const cost = page.getByRole('region', { name: 'What it cost', exact: true })
    await expect(cost.locator('[data-slot="chart-title"]').first()).toHaveText('—')
    await expect(cost).toContainText('No usage recorded in this window')
    await expect(cost.getByText('0 of 30 days scanned', { exact: true })).toHaveCount(1)
    await expect(cost.locator('[data-slot="chart-foot"]')).not.toContainText('days scanned')
    await expect(cost).not.toContainText('unpriced')
    if (view === 'overview') await expect(page.getByRole('button', { name: /^Value/ })).not.toContainText('unpriced')
  }
})

test('FIX9 shorter spend figures distinguish unscanned days from quiet days', async ({ page }) => {
  for (const state of ['mixed', 'zero']) {
    await openFrame(page, `frame-wall=dashboard&frame-view=spend&frame-fix9-ledger=${state}`)
    const today = page.locator('[data-slot="stat"]').filter({ hasText: 'Today' })
    await expect(today).toContainText(state === 'mixed' ? 'Not read yet' : '$0')
  }
})

test('FIX9 hourly tokens name the subset and the missing amount', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=activity&frame-fix9-hours=1')
  await page.getByRole('combobox', { name: 'Show by', exact: true }).selectOption('hour')
  const activity = page.getByRole('region', { name: 'When it ran', exact: true })
  await expect(activity).toContainText('Tokens with a recorded hour')
  await expect(activity.getByText('200 tokens have no recorded hour.', { exact: true })).toHaveCount(1)
})

test('FIX9 Projects names an empty current project beside spend elsewhere', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=projects&frame-fix9-project=empty')
  for (const view of ['goal', 'agent']) {
    await page.getByRole('combobox', { name: 'Project usage view' }).selectOption(view)
    await expect(page.getByRole('region', { name: `${view === 'goal' ? 'Team' : 'Agent'} usage in storefront`, exact: true })).toContainText('No Team usage in storefront in the last 30 days')
  }
  await openFrame(page, 'frame-wall=dashboard&frame-view=projects&frame-fix9-project=none')
  await expect(page.getByText('Open a project to see its Team usage.', { exact: true })).toBeVisible()
})


test('FIX9 unavailable conversation keeps its notes in the reading column', async ({ page }) => {
  for (const width of [1600, 1280]) {
    await openFrame(page, 'frame-wall=conversation&frame-fix8-kept=1', width)
    await page.getByRole('button', { name: 'Kept conversation', exact: true }).click()
    await expect.soft(page.locator('[data-frame-region="top"]')).not.toContainText('Idle')
    const transcript = page.locator('[data-live-transcript]')
    const message = transcript.getByText('First kept message', { exact: true })
    const note = transcript.getByText(/HarnessDesk’s copy/)
    const refusal = page.locator('[data-slot="composer-dock"]').getByText(/Choose a working installation in Settings/)
    const boxes = await Promise.all([message, note, refusal].map(locator => locator.boundingBox()))
    for (const box of boxes.slice(1)) {
      expect(Math.abs(box!.x - boxes[0]!.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(box!.width - boxes[0]!.width)).toBeLessThanOrEqual(1)
    }
    expect(boxes[1]!.y + boxes[1]!.height).toBeLessThanOrEqual(boxes[0]!.y)
  }
})

test('FIX9 confirmed sign out uses one phrase on the list and detail', async ({ page }) => {
  await openFrame(page, 'frame-wall=settings-runtimes&frame-fix9-signout=1')
  const row = page.locator('[data-slot="agent-row"]').filter({ hasText: 'Fixture agent' })
  await expect(row).toContainText('Signed out')
  await row.click()
  await expect(page.getByText('Signed out', { exact: true }).first()).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Not signed in')
})

test('FIX9 absent plan reports are explained once', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=overview&frame-empty-usage=1&frame-fix9-silent=1')
  const left = page.getByRole('region', { name: 'What is left', exact: true })
  await expect(left).toContainText('No agent here reports plan usage.')
  await expect(left).not.toContainText('agents don’t report usage')
})

test('FIX9 spend grouping uses sentence case', async ({ page }) => {
  await openFrame(page, 'frame-wall=dashboard&frame-view=spend')
  const options = page.getByRole('combobox', { name: 'Group spend by', exact: true })
  await expect(options).toContainText('By agent')
  await expect(options).toContainText('By model')
  await expect(options).toContainText('By project')
})

test('FIX9 floating Changes uses overlay elevation', async ({ page }) => {
  for (const width of [1100, 720]) {
    await openFrame(page, 'frame-wall=conversation', width)
    await page.getByRole('button', { name: 'Changes', exact: true }).first().click()
    const panel = page.locator('[data-frame-region="right"]:visible')
    const shadows = await panel.evaluate(element => {
      const probe = document.createElement('div'); probe.style.boxShadow = 'var(--hd-shadow-lg)'; element.append(probe)
      const values = [getComputedStyle(element).boxShadow, getComputedStyle(probe).boxShadow]; probe.remove(); return values
    })
    expect(shadows[0]).not.toBe('none')
    expect(shadows[0]).toBe(shadows[1])
  }
})

test('FIX9 theme thumbnails use neutral selection across accents', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await openFrame(page, 'frame-wall=settings&frame-section=appearance', 1280, theme)
    await page.getByRole('combobox', { name: 'Interface', exact: true }).selectOption('studio')
    await expect(page.locator('body')).toHaveAttribute('data-hd-interface', 'studio')
    const rows = page.getByRole('radiogroup', { name: 'Theme', exact: true }).locator('svg rect[x="10"][y="30"]')
    await expect(rows).toHaveCount(4)
    const neutral = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.color = 'var(--hd-sidebar-selected)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color })
    await page.getByRole('radio', { name: 'Violet', exact: true }).click()
    await expect(page.locator('body')).toHaveAttribute('data-hd-accent', 'violet')
    const violet = await rows.evaluateAll(elements => elements.map(element => getComputedStyle(element).fill))
    await page.getByRole('radio', { name: 'Green', exact: true }).click()
    await expect(page.locator('body')).toHaveAttribute('data-hd-accent', 'green')
    const green = await rows.evaluateAll(elements => elements.map(element => getComputedStyle(element).fill))
    expect(green).toEqual(violet)
    expect(green).toEqual(Array(4).fill(neutral))
  }
})

test('FIX9 unavailable Findings names its refusal without an internal noun', async ({ page }) => {
  await openFrame(page, 'frame-wall=team&frame-fix9-no-findings=1')
  await expect(page.getByRole('tab', { name: 'Findings 3', exact: true })).toHaveAttribute('title', 'This Team has no findings')
})
