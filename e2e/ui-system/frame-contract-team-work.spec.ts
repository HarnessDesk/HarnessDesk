import { expectTitleRoom } from './title-contract'
import { selectRunView } from './run-frame-actions'
import { expect, test } from '@playwright/test'
import { FRAME, FRAME_TOKENS } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { selectFrameTab } from './frame-actions'
import { openFrame, resolvedPx } from './frame-contract-helpers'
import { closeTeamDetails, teamDetails } from './team-frame-actions'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


for (const theme of WALL_THEMES) {
  test.describe(`B6 Team view controls live in the body in ${theme}`, () => {
    for (const tab of ['overview', 'run', 'board', 'room', 'findings']) test(`B6 Team mounts body View only for a destination with choices in ${theme}: ${tab}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team', theme)
      await selectFrameTab(page, tab)
      const main = page.locator('[data-slot="workbench-main"]')
      const icon = main.locator('[data-slot="page-options"]:visible').getByRole('button', { name: /^(View|Chat|Split)$/ })
      const work = tab === 'overview' || tab === 'run'
      await expect(icon).toHaveCount(work ? 0 : 1)
      if (work) {
        await expect(main.locator('[data-slot="run-flow"]')).toBeVisible()
        await expect(main.getByRole('button', { name: 'Stop run…', exact: true })).toBeVisible()
      }
      else {
        await expect(icon).toBeVisible()
        expect(await icon.evaluate(node => node.closest('[data-slot="top-bar"]'))).toBeNull()
        // The control sits on the page head with the Team's name; the tabs follow below.
        expect(await icon.evaluate(node => node.closest('[data-page-head]') !== null)).toBe(true)
        const tabs = (await main.getByRole('tablist', { name: 'Team views', exact: true }).boundingBox())!
        const control = (await icon.boundingBox())!
        expect(control.y + control.height).toBeLessThanOrEqual(tabs.y)
        expect(control.x).toBeGreaterThanOrEqual(tabs.x)
      }
      await expect(page.locator('[data-slot="top-bar"]').getByRole('button', { name: 'View', exact: true })).toHaveCount(0)
      await expect(page.locator('[data-slot="view-bar"]')).toHaveCount(0)
      await expect(page.locator('[data-slot="run-header"]')).toHaveCount(0)
    })
    test(`B6 Findings keeps its selected filter in the body in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team', theme)
      await selectFrameTab(page, 'findings')
      await page.getByRole('button', { name: 'View', exact: true }).click()
      await page.getByRole('switch', { name: 'Open', exact: true }).click()
      await page.getByRole('button', { name: 'View', exact: true }).click()
      await expect(page.getByRole('switch', { name: 'Open', exact: true })).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Decide this run', exact: true })).toBeVisible()
    })
  })

  test(`B5 equivalent completed rounds stay folded and select their latest record in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team-run-equivalent', theme)
    await selectFrameTab(page, 'run')
    const main = page.locator('[data-slot="workbench-main"]')
    await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Timeline')
    const group = main.locator('[data-slot="run-steps"] [data-round-group]')
    await expect(group).toHaveCount(1)
    await expect(group).toContainText('Rounds 1–2')
    await expect(group).toContainText('2 runs')
    await expect(main.locator('[data-slot="timeline-records"]')).toHaveCount(0)
    await group.click()
    await expect(main.locator('[data-row="card-2-2"]')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('[data-slot="work-tools"]:visible [data-slot="run-inspector"]')).toContainText('#2')
    await page.getByRole('button', { name: 'Close pane', exact: true }).click()
    await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Flow')
    await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Timeline')
    await expect(group).toHaveCount(1)
    await expect(main.locator('[data-row="card-2-2"]')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('[data-slot="work-tools"]:visible')).toHaveCount(0)
  })

  for (const width of [1440, 720]) {
    test(`B5 Steps stay in main and Run View preserves the canonical bar at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team-run-recorded', theme, width)
      await selectFrameTab(page, 'run')
      const bar = page.locator('[data-slot="top-bar"]:visible').first()
      const main = page.locator('[data-slot="workbench-main"]')
      await expect(page.locator('[data-slot="run-header"]')).toHaveCount(0)
      await expect(main.locator('[data-slot="run-steps"]')).toBeVisible()
      await expect(page.locator('[data-slot="work-tools"] [data-slot="run-steps"]')).toHaveCount(0)
      await expect(page.locator('[data-slot="work-tools"]:visible')).toHaveCount(0)
      await expect(bar.locator('[data-work-tool]')).toHaveCount(4)
      const verb = main.getByRole('button', { name: 'Stop run…', exact: true })
      await expect(verb).toBeVisible()
      await expect(verb.locator('svg')).toHaveCount(0)
      await expectTitleRoom(bar.locator('[data-topbar-title]'))
      const before = (await verb.boundingBox())!
      await expect(main.getByRole('button', { name: /^(View|Flow|Timeline)$/ })).toHaveCount(0)
      await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Flow')
      await expect(main.locator('[data-slot="run-flow"]')).toBeVisible()
      await expect(main.locator('[data-slot="flow-canvas"] .react-flow__node')).toHaveCount(4)
      await expect.poll(async () => (await verb.boundingBox())!.x).toBe(before.x)
      await expectTitleRoom(bar.locator('[data-topbar-title]'))
      await expect(page.locator('[data-slot="work-tools"]:visible')).toHaveCount(0)
      await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Timeline')
      await expect(main.locator('[data-slot="run-steps"]')).toBeVisible()
      await expect(page.locator('[data-slot="work-tools"]:visible')).toHaveCount(0)
      const future = main.locator('[data-slot="run-steps"] [data-step-row="person"]')
      await future.click()
      await expect(future).toHaveAttribute('aria-current', 'true')
      await page.getByRole('button', { name: 'Close pane', exact: true }).click()
      await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Flow')
      await expect(main.locator('[data-slot="flow-step"][data-step="person"]')).toHaveAttribute('data-selected', 'true')
      await selectRunView(page.locator('[data-frame-id="frame-wall"]'), 'Timeline')
      await expect(future).toHaveAttribute('aria-current', 'true')
      await expect(page.locator('[data-slot="work-tools"]:visible')).toHaveCount(0)
    })
  }

  test(`B3 narrow Team Run retains its timeline after automatic panel collapse in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, 720)
    await selectFrameTab(page, 'run')
    const main = page.locator('[data-slot="workbench-main"]')
    await expect(main).toBeVisible()
    await expect(main.locator('[data-slot="run-workspace"]')).toBeVisible()
    await expect(main).toContainText('Round 1')
    const details = await teamDetails(page.locator('[data-frame-id="frame-wall"]'))
    await expect(details.locator('[aria-label="Team Run facts"]')).toBeVisible()
    await expect(details.locator('[data-slot="tool-section"][aria-label="Seats"]')).toBeVisible()
    await expect(details.locator('[data-slot="summary-card"][data-surface="card"]')).toHaveCount(0)
    // The canonical toggle stays above the covered main area and returns to
    // the same timeline without reselecting or releasing the retained record.
    await closeTeamDetails(page.locator('[data-frame-id="frame-wall"]'))
    await expect(main).toBeVisible()
    await expect(main).toContainText('Round 1')
    // The ordinary wall Run truthfully records no Flow steps. Use the existing
    // synthetic recorded-Flow rig for its narrow Steps visibility boundary.
    await openFrame(page, 'run-dock', theme, 720)
    await selectFrameTab(page, 'run')
    await selectRunView(page.locator('#run-dock-frame'), 'Flow')
    await expect(main.locator('[data-slot="flow-canvas"] .react-flow__node')).toHaveCount(4)
    await expect(main.locator('[data-slot="flow-list"] section[aria-label="Rules"]')).toHaveCount(1)
    await selectRunView(page.locator('#run-dock-frame'), 'Timeline')
    await expect(main.locator('[data-slot="run-steps"]')).toBeVisible()
    await expect(main.locator('[data-slot="run-steps"] [data-step-row]')).toHaveCount(5)
    await expect(main).toContainText('Taken 4')
    await expect(main).toContainText('Not reached 1')
    // The canonical toggle restores remembered Details on one press; Flow
    // retains its native Rules alternative and Timeline Steps without a Steps tool.
    await expect(await teamDetails(page.locator('#run-dock-frame'))).toContainText('Seats')
    await expect(page.locator('[data-frame-region="rail"] [data-slot="run-steps"]')).toHaveCount(0)
    await closeTeamDetails(page.locator('#run-dock-frame'))
    await expect(main).toBeVisible()
  })

  test(`frame tokens resolve to the contract in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    for (const [token, px] of Object.entries(FRAME_TOKENS)) {
      expect(await resolvedPx(page, token), token).toBe(px)
    }
  })
}


for (const theme of WALL_THEMES) {
  test(`B4 Team tabs own navigation and Chat owns its layout in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await expect(page.locator('[data-slot="top-bar"]')).toHaveCount(1)
    await expect(page.locator('[data-team-page="overview"]')).toBeVisible()
    await expect(page.locator('[data-team-page="side-by-side"]')).toHaveCount(0)
    const details = await teamDetails(page.locator('[data-frame-id="frame-wall"]'))
    await expect(details).toBeVisible()
    await expect(details.locator('[data-slot="tool-section"] > [data-slot="group-label"]').first()).toContainText('Run')
    const headings = await details.locator('[data-slot="tool-section"] > [data-slot="group-label"]').evaluateAll(nodes => nodes.map(node => node.textContent))
    expect(headings[0]).toContain('Run')
    expect(headings[1]).toContain('Seats')
    await selectFrameTab(page, 'room')
    await page.getByRole('button', { name: /^(Chat|Split)$/ }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Chat', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: 'Split', exact: true })).toBeVisible()
  })
  test(`B4 Chat has one composer edge and no view toolbar in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await selectFrameTab(page, 'room')
    await expect(page.locator('[data-slot="view-bar"]')).toHaveCount(0)
    const composer = page.locator('[data-slot="room-body"] [data-slot="composer"]:visible').first()
    await expect(composer).toBeVisible()
    const content = page.locator('[data-slot="room-body"]')
    const composerBox = (await composer.boundingBox())!, contentBox = (await content.boundingBox())!
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(contentBox.y + contentBox.height + 1)
  })
}

for (const theme of WALL_THEMES) {
  test(`B4a Hold lives in Send to and preserves the person's draft in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, 720)
    await selectFrameTab(page, 'room')
    const composer = page.locator('[data-slot="room-body"] [data-slot="composer"]:visible').first()
    const input = composer.locator('textarea').first()
    await input.fill('Check the retry budget')
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await page.getByRole('switch', { name: 'Board-only', exact: true }).click()
    await expect(composer.getByText('Board-only', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('Check the retry budget')
    await expect(input).toBeEnabled()
    await expect(page.locator('[data-slot="top-bar"]').getByRole('button', { name: /Board-only/ })).toHaveCount(0)
    expect(Math.round((await page.locator('[data-slot="top-bar"]').locator('..').boundingBox())!.height)).toBe(FRAME.bar.height)
  })
}

for (const theme of WALL_THEMES) {
  test(`B4a Side by side shares Hold with the controlled Chat draft in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await selectFrameTab(page, 'room')
    const input = page.locator('[data-slot="room-body"] [data-slot="composer"]:visible textarea').first()
    await input.fill('Check the retry budget')
    await page.getByRole('button', { name: 'Send to', exact: true }).click()
    await page.getByRole('switch', { name: 'Board-only', exact: true }).click()
    await page.getByRole('button', { name: /^(Chat|Split)$/ }).click()
    await page.getByRole('menuitemradio', { name: 'Split', exact: true }).click()
    const shared = page.locator('[data-shared-composer]:visible')
    await expect(shared.getByText('Board-only', { exact: true })).toBeVisible()
    await expect(shared.locator('textarea')).toHaveValue('Check the retry budget')
    await expect(shared.locator('textarea')).toBeEnabled()
    await shared.getByRole('button', { name: 'Send to', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Board-only', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('switch', { name: 'Board-only', exact: true }).click()
    await expect(shared.getByText('Board-only', { exact: true })).toHaveCount(0)
    await expect(shared.locator('textarea')).toHaveValue('Check the retry budget')
  })
}
