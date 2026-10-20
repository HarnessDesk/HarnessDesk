import { measureDestination, expectPageJourney } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { openFrame, resolvedPx } from './frame-contract-helpers'
import { revealPreviewConversation } from './sidebar-preview-actions'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


// E4 uses the actual App handlers and the common history fixture.
for (const width of [1440, 720]) test(`E4 Agents page journey ${width}`, async ({ page }) => {
  await expectPageJourney(page, 'Agents', 'agents', width)
})
test('E4 Agents named history', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  await page.locator('[aria-label="Main sections"]').getByRole('button', { name: 'Agents', exact: true }).click()
  const bar = page.locator('[data-slot="top-bar"]:visible')
  await expect(page.locator('[data-page-destination="agents"]:visible')).toHaveCount(1)
  await page.getByRole('button', { name: /Code reviewer/ }).first().click()
  const body = page.locator('[data-page-destination="agents"]:visible')
  await expect(body.getByRole('button', { name: 'Back to Agents', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+[')
  await expect(body.getByRole('button', { name: 'New Agent…', exact: true })).toBeVisible()
  await page.keyboard.press('Meta+]')
  await expect(body.getByRole('heading', { level: 1 })).toHaveText('Code reviewer')
  await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
  await body.getByRole('button', { name: 'Back to Agents', exact: true }).click()
  await expect(body.getByRole('button', { name: 'New Agent…', exact: true })).toBeVisible()
})

// Until Task 9 joins the shared preview assembly, load the lane-owned preview
// entry in the existing preview document. It renders App and the real AppStore.

for (const theme of ['light', 'dark'] as const) for (const width of [2200, 1440, 1100, 720]) {
  for (const detail of [false, true]) test(`E4 Agents ${detail ? 'detail' : 'roster'} ${width} ${theme}`, async ({ page }) => {

    await measureDestination(page, `frame-wall=agents${detail ? '&frame-detail=agent' : ''}`, detail ? 'reading' : 'wide', theme, width)
    await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    if (detail) {
      const body = page.locator('[data-page-destination="agents"]:visible')
      await expect(body.getByRole('button', { name: 'Back to Agents', exact: true })).toBeVisible()
      await expect(body.getByRole('button', { name: /^Start a conversation as / })).toBeVisible()
      await expect(bar.getByRole('button', { name: /^Start a conversation as / })).toHaveCount(0)
    }
  })
}
for (const state of ['parse', 'refused', 'missing']) test(`E4 Agents ${state} keeps the destination`, async ({ page }) => {

  await measureDestination(page, `frame-wall=agents&frame-agent-case=${state}`, state === 'missing' ? 'wide' : 'reading', 'light', 1440)
  const main = page.locator('[data-page-destination="agents"]:visible')
  if (state === 'parse') await expect(main).toContainText('Why it will not parse')
  if (state === 'refused') await expect(main).toContainText('signed out')
  if (state === 'missing') await expect(main).toContainText('Who does the work')
})
for (const width of [1440, 720]) test(`E4 Agents column opens draft session and Settings ${width}`, async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light', width)
  const reveal = async () => { if (width === 720) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click() }
  await reveal()
  const column = page.locator('[data-left-column]:visible')
  const agents = () => column.locator('[aria-label="Main sections"]').getByRole('button', { name: 'Agents', exact: true }).click()
  await agents(); await reveal()
  await column.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="agents"]:visible')).toHaveCount(1)
  await reveal()
  await (await revealPreviewConversation(column, 'Add fixtures for the refund path before extending the checkout matrix')).click()
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="agents"]:visible')).toHaveCount(1)
  await reveal()
  await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="agents"]:visible')).toHaveCount(1)
})

for (const detail of [false, true]) test(`E4 Agents ${detail ? 'detail' : 'roster'} More offers the project Terminal without Back to app`, async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  await page.locator('[aria-label="Main sections"]').getByRole('button', { name: 'Agents', exact: true }).click()
  if (detail) await page.getByRole('button', { name: /Code reviewer/ }).first().click()
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  const items = page.locator('[role="menuitem"], [role="menuitemradio"]')
  await expect(items.filter({ hasText: 'Back to app' })).toHaveCount(0)
  await expect(items.filter({ hasText: 'Terminal' })).toHaveCount(1)
})

test('R10 Agents source notes keep middle-truncated paths content-sized', async ({ page }) => {
  await openFrame(page, 'frame-wall=agents&frame-agent-path=long', 'light', 1440)
  const main = page.locator('[data-page-destination="agents"]:visible')
  const sources = main.getByRole('button', { name: 'Sources and precedence', exact: true })
  await expect(sources).toHaveAttribute('aria-expanded', 'false')
  await expect(main.locator('section[aria-label^="Sources:"]')).toHaveCount(0)
  await sources.click()
  await expect(sources).toHaveAttribute('aria-expanded', 'true')
  const project = main.locator('section[aria-label="Sources: Project"] [data-slot="middle-truncate"]')
  const userNote = main.locator('section[aria-label="Sources: Yours"] [data-slot="note"]')
  const userPath = userNote.locator('[data-slot="middle-truncate"]')
  await userNote.scrollIntoViewIfNeeded()
  await expect(project).toBeVisible()
  await expect(userPath).toBeVisible()
  const pathGeometry = await project.evaluate(node => {
    const right = Math.max(...[...node.querySelectorAll<HTMLElement>('[data-part]')].map(part => part.getBoundingClientRect().right))
    const next = node.nextElementSibling!.getBoundingClientRect()
    return {
      pathGap: node.getBoundingClientRect().right - right,
      sentenceGap: next.left - node.getBoundingClientRect().right,
    }
  })
  expect(pathGeometry.pathGap).toBeLessThanOrEqual(2)
  expect(pathGeometry.sentenceGap).toBeLessThanOrEqual(10)
  await expect(userPath).toHaveAttribute('title', '/private/tmp/synthetic-agent-fixture/isolated/worker/worktrees/round-four/app-frame-fix4-lists4/shared-home/profile/.harnessdesk/agents')
  expect((await userNote.boundingBox())!.height).toBeLessThanOrEqual(21)
})

test('R10 Release checker keeps the roster face and drops the redundant origin line', async ({ page }) => {
  await openFrame(page, 'frame-wall=agents&frame-detail=agent&frame-agent-case=release', 'light', 1440)
  const bar = page.locator('[data-slot="top-bar"]:visible')
  const face = page.locator('[data-page-destination="agents"]:visible [data-slot="toolbar"] [data-slot="icon-tile"]')
  await expect(page.locator('[data-page-destination="agents"]:visible h1')).toHaveText('Release checker')
  await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
  await expect(face).toContainText('RC')
  const explanations = page.locator('[data-page-destination="agents"]:visible [data-slot="page"] > p[data-role="prose"]')
  await expect(explanations).toHaveCount(1)
  await expect(explanations).toContainText('Reads a release branch')
})

test('R10 Release checker automatic trigger names its action and keeps dialog rhythm', async ({ page }) => {
  await openFrame(page, 'frame-wall=agents&frame-detail=agent&frame-agent-case=release', 'light', 1440)
  const bar = page.locator('[data-slot="top-bar"]:visible')
  await bar.getByRole('button', { name: 'More', exact: true }).click()
  const runAutomatically = page.getByRole('menuitem', { name: 'Run automatically…', exact: true })
  await expect(runAutomatically).toBeVisible()
  await runAutomatically.click()
  const dialog = page.getByRole('dialog', { name: 'Run Release checker automatically', exact: true })
  await expect(dialog).toBeVisible()
  const events = dialog.locator('section[aria-label="Events"]')
  await expect(events.getByText('Opened', { exact: true })).toBeVisible()
  await expect(events.getByText('Pushed', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Pull request', { exact: true }).first()).toBeVisible()
  await expect(dialog.getByText('Head commit', { exact: true }).first()).toBeVisible()
  const eventRows = events.locator('[data-slot="rows"]').first()
  const forks = events.locator('[data-slot="form-field"]').first()
  const gap = (await forks.boundingBox())!.y - ((await eventRows.boundingBox())!.y + (await eventRows.boundingBox())!.height)
  expect(gap).toBeGreaterThanOrEqual(await resolvedPx(page, '--hd-space-6') - 1)
})

test('R10 built-in shadow status uses the source row reserved chip column', async ({ page }) => {
  await openFrame(page, 'frame-wall=agents', 'light', 1440)
  const main = page.locator('[data-page-destination="agents"]:visible')
  const sources = main.getByRole('button', { name: 'Sources and precedence', exact: true })
  await expect(sources).toHaveAttribute('aria-expanded', 'false')
  await sources.click()
  const builtin = main.locator('section[aria-label="Sources: Built in"]')
  const shadow = builtin.locator('[data-slot="row"]').filter({ hasText: 'Shadowed by the project copy. This copy is not used.' })
  const chip = shadow.locator('[data-slot="row-ctl"] [data-slot="chip"]')
  await expect(chip).toHaveText('Shadowed')
  await shadow.scrollIntoViewIfNeeded()
  const chipBox = (await chip.boundingBox())!, controlBox = (await shadow.locator('[data-slot="row-ctl"]').boundingBox())!
  const endBox = (await shadow.locator('[data-slot="row-end"]').boundingBox())!, chevronBox = (await shadow.locator('[data-slot="row-chevron-space"]').boundingBox())!
  expect(Math.abs(chipBox.x + chipBox.width - controlBox.x - controlBox.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(endBox.x + endBox.width - chevronBox.x - chevronBox.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(chevronBox.x - controlBox.x - controlBox.width - await resolvedPx(page, '--hd-space-6'))).toBeLessThanOrEqual(1)
  await sources.click()
  await expect(sources).toHaveAttribute('aria-expanded', 'false')
  await expect(main.locator('section[aria-label^="Sources:"]')).toHaveCount(0)
})
