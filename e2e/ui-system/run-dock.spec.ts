import { closeRunInspector, selectRunView } from './run-frame-actions'
import { expect, test } from '@playwright/test'
import path from 'node:path'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'
import { minimapOverlaps, zoomOf } from './canvas-minimap'
import { FRAME } from '../../packages/ui/src/design/frame'
import { closeTeamDetails, selectTeamDestination, selectTeamPage, teamDetails, teamSeats } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`the docked Run Flow fills its pane and contains every step in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame, 'run')
    await selectRunView(frame, 'Flow')
    const canvas = frame.locator('[data-slot="workbench-main"] [data-slot="flow-canvas"]')
    await expect(canvas.locator('.react-flow__node')).toHaveCount(4)
    const capture = async () => {
      if (!process.env.FLOW_DOCK_FRAMES_DIR) return
      expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
      await frame.screenshot({ path: path.join(process.env.FLOW_DOCK_FRAMES_DIR, `round4-run-dock-${theme}-${process.env.FLOW_DOCK_FRAME_PHASE ?? 'after'}.png`) })
    }
    if (process.env.FLOW_DOCK_FRAME_PHASE === 'before') await capture()
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => canvas.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(200)
      await expect.poll(() => canvas.evaluate(el => {
        const clip = el.getBoundingClientRect()
        return [...el.querySelectorAll('.react-flow__node')].every(node => {
          const box = node.getBoundingClientRect()
          return box.top >= clip.top && box.bottom <= clip.bottom + 0.5 && box.left >= clip.left && box.right <= clip.right + 0.5
        })
      })).toBe(true)
      if (width === 1440 && process.env.FLOW_DOCK_FRAME_PHASE !== 'before') await capture()
    }
  })

  {

    for (const [item0, width] of ([480, 520, 560, 600]).entries()) test(`native narrow Run Flow keeps its Steps and geometry in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width, height: 700 })
      await page.goto(`/preview.html?run-dock&theme=${theme}`)
      const frame = page.locator('#run-dock-frame')
      await selectTeamDestination(frame, 'run')
      await selectRunView(frame, 'Flow')
      const main = frame.locator('[data-slot="workbench-main"]')
      const canvas = main.locator('[data-slot="flow-canvas"]')
      const list = main.locator('[data-slot="flow-list"]')
      await expect(canvas.locator('.react-flow__node')).toHaveCount(4)
      await expect.poll(() => zoomOf(canvas)).toBeLessThan(0.6)
      if (process.env.FLOW_DOCK_FRAMES_DIR) {
        await page.evaluate(async () => { await document.fonts.ready })
        expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
        await frame.screenshot({ path: path.join(process.env.FLOW_DOCK_FRAMES_DIR, `round5-run-dock-${width}-${theme}-${process.env.FLOW_DOCK_FRAME_PHASE ?? 'after'}.png`) })
      }
      await expect.soft(list, `accessible Flow descriptions at ${width}px`).toHaveAttribute('data-placement', 'dock')
      await selectRunView(frame, 'Timeline')
      const record = main.locator('[data-slot="run-steps"]')
      await expect(record.locator('[data-step-row][data-row]')).toHaveCount(4)
      expect.soft((await record.locator('[data-step-row]').first().boundingBox())!.width, `record row at ${width}px`).toBeGreaterThan(200)
      const drawn = (await canvas.boundingBox())!.height
      expect.soft(drawn, `canvas at ${width}px`).toBeGreaterThan(300)
      await expect(main.locator('[data-slot="run-flow"]'), `Flow remains beside full history at ${width}px`).toBeVisible()
      expect.soft(await canvas.evaluate(el => {
        const clip = el.getBoundingClientRect()
        return [...el.querySelectorAll('.react-flow__node')].every(node => {
          const box = node.getBoundingClientRect()
          return box.top >= clip.top && box.bottom <= clip.bottom + 0.5 && box.left >= clip.left && box.right <= clip.right + 0.5
        })
      }), `steps at ${width}px`).toBe(true)
      expect.soft(await minimapOverlaps(canvas), `minimap at ${width}px`).toEqual([])


    })
  }

  {

    for (const [item0, width] of ([720, 780, 840]).entries()) test(`Timeline keeps every original round and unreached Step when Details is put away in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width, height: 800 })
      await page.goto(`/preview.html?run-dock&theme=${theme}`)
      const frame = page.locator('#run-dock-frame')
      await frame.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      await expect(frame.locator('[data-slot="workbench-scrim"]')).toBeVisible()
      await frame.locator('[data-slot="workbench-scrim"]').click()
      await expect(frame.locator('[data-slot="workbench-scrim"]')).toBeHidden()
      await selectTeamPage(frame, 'run')
      await selectRunView(frame, 'Flow')
      await closeTeamDetails(frame)
      const main = frame.locator('[data-slot="workbench-main"]')
      const canvas = main.locator('[data-slot="flow-canvas"]')
      const scroll = main.locator('[data-slot="run-scroll"]')
      const rules = main.locator('[data-slot="flow-list"] section[aria-label="Rules"]')
      await expect(rules).toHaveCount(1)
      await expect(canvas.locator('.react-flow__node')).toHaveCount(4)
      await selectRunView(frame, 'Timeline')
      const list = main.locator('[data-slot="run-steps"]')
      await expect(frame.locator('[data-slot="dock-panel"][data-edge="left"]'), `dock at ${width}px`).toHaveCount(0)
      if (process.env.FLOW_DOCK_FRAMES_DIR) {
        await page.evaluate(async () => { await document.fonts.ready })
        expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
        await frame.screenshot({ path: path.join(process.env.FLOW_DOCK_FRAMES_DIR, `round6-run-put-away-${width}-${theme}-${process.env.FLOW_DOCK_FRAME_PHASE ?? 'after'}.png`) })
      }
      await expect(list, `Timeline at ${width}px`).toBeVisible()
      const rows = list.locator('[data-step-row][data-row]')
      await expect(rows).toHaveCount(4)
      expect.soft(await rows.count(), `step rows at ${width}px`).toBeGreaterThan(0)
      expect.soft(await rows.first().evaluate(el => el.getBoundingClientRect().width), `step row at ${width}px`).toBeGreaterThan(200)
      const area = (await scroll.boundingBox())!
      await page.mouse.move(area.x + area.width / 2, area.y + area.height - 30)
      await page.mouse.wheel(0, 2000)
      await expect.poll(() => scroll.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1), `end of the pane at ${width}px`).toBe(true)
      await expect.soft(list.locator('[data-step-row="person"]'), `unreached Step at ${width}px`).toBeInViewport()


    })
  }

  test(`Timeline keeps its original Steps beside the rail and a selected inspector in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    // At a standing width, subject facts and selected inspection share the Timeline.
    await page.setViewportSize({ width: 1440, height: 800 })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame, 'run')
    await selectRunView(frame, 'Timeline')
    const list = frame.locator('[data-slot="workbench-main"] [data-slot="run-steps"]')
    await teamDetails(frame)
    await expect(list, 'canonical Run facts do not hide the Steps').toBeVisible()
    await list.locator('[data-row="card-3-3"]').click()
    await expect(frame.locator('[data-slot="work-tools"]:visible [data-slot="run-inspector"]')).toBeVisible()
    await expect(list, 'the selected record does not own the Steps list').toBeVisible()
    await expect(await teamDetails(frame)).toContainText('Seats')
    await closeRunInspector(frame)
    await expect(list, 'closing inspection keeps the Steps readable').toBeVisible()
  })

  test(`Team rail keeps Run facts and Seats separate from selected inspection in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame, 'run')
    const main = frame.locator('[data-slot="workbench-main"]')
    const summary = await teamDetails(frame)
    const facts = summary.locator('[aria-label="Team Run facts"]')
    await expect(facts).toContainText('#412')
    await expect(facts).toContainText('fix/checkout-502')
    await expect(facts).toContainText('Round 4 of 24')
    await expect(facts).not.toContainText('1 of 3 rounds')
    await summary.getByRole('button', { name: 'Record details', exact: true }).click()
    const recordDetails = summary.locator('[aria-label="Run record details"]')
    await expect(recordDetails).toContainText('3 of 24 rounds')
    await expect(recordDetails).toContainText('1 of 3 rounds')
    await expect(summary.locator('[data-slot="card"]')).toHaveCount(0)
    await expect(summary.locator('[data-slot="run-inspector"]')).toHaveCount(0)
    await expect((await teamSeats(frame)).locator('[data-slot="list-row"]')).toHaveCount(2)
    const keyValues = await facts.evaluate(element => [...element.querySelectorAll('[data-slot="summary-item"]')].map(row => {
      const key = row.querySelector('dt')!.getBoundingClientRect()
      const value = row.querySelector('[data-slot="summary-value"]')!
      return { left: Math.round(value.getBoundingClientRect().left), key: Math.round(key.width), align: getComputedStyle(value).textAlign }
    }))
    expect(new Set(keyValues.map(value => value.left)).size).toBe(1)
    expect(keyValues.every(value => value.key === FRAME.summaryKey.icon && value.align === 'left')).toBe(true)
    expect(await summary.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `details-after-${theme}.png`) })
    await summary.getByRole('button', { name: 'Flow file', exact: true }).click()
    const flowDialog = page.getByRole('dialog')
    await expect(flowDialog).toContainText('This is the file as it is now.')
    await expect(flowDialog).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(flowDialog).toHaveCount(0)
    // Four recorded round visits and the unreached person remain in Timeline; Flow shows four step identities.
    // Switching representations neither admits a Steps tool nor discards selection.
    await selectRunView(frame, 'Timeline')
    const timelineSteps = main.locator('[data-slot="run-steps"]')
    for (const id of ['card-1-1', 'check-2-2', 'card-3-3', 'card-4-4']) await expect(timelineSteps.locator(`[data-row="${id}"]`)).toHaveCount(1)
    await expect(frame.locator('[data-slot="tool-body"] [data-slot="run-steps"]')).toHaveCount(0)
    await expect(timelineSteps.locator('[data-step-row][data-selected="true"]')).toHaveCount(0)
    await timelineSteps.locator('[data-row="card-4-4"] button').first().click()
    await expect(timelineSteps.locator('[data-row="card-4-4"]')).toHaveAttribute('data-selected', 'true')
    await selectRunView(frame, 'Flow')
    const steps = main.locator('[data-slot="flow-list"]')
    await expect(steps.locator('[data-step-row]')).toHaveCount(4)
    await expect(steps.locator('[data-slot="chip"][data-tone="info"]')).toHaveText('Working')
    await expect(steps.locator('[data-slot="chip"][data-tone="warning"]')).toHaveText('Request changes')
    const flowNode = main.locator('[data-step="reviewer"]')
    const row = steps.locator('[data-step-row="reviewer"]')
    await expect(row.locator('[data-slot="list-row-subtitle"]')).toContainText('request-changes')
    await expect(row.locator('[data-slot="list-row-trail"]')).toContainText('1 run')
    await flowNode.click()
    await expect(flowNode).toHaveAttribute('data-selected', 'true')
    await expect((await teamDetails(frame)).locator('[data-slot="run-inspector"]')).toHaveCount(0)
    await expect((await teamDetails(frame)).getByText('Seats', { exact: true })).toBeVisible()
    await selectRunView(frame, 'Timeline')
    await main.locator('[data-row="card-3-3"]').click()
    await expect(timelineSteps.locator('[data-row="card-3-3"]')).toHaveAttribute('data-selected', 'true')
    await selectRunView(frame, 'Flow')
    await expect(flowNode).toHaveAttribute('data-selected', 'true')
    await closeRunInspector(frame)
    await closeTeamDetails(frame)
    await main.locator('[data-step="person"]').click()
    await expect(main.locator('[data-step="person"]')).toHaveAttribute('data-selected', 'true')
    expect(await main.locator('[data-slot="run-flow"]').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `steps-after-${theme}.png`) })
    await closeRunInspector(frame)
    await closeTeamDetails(frame)
    await expect(await teamDetails(frame)).toContainText('Seats')
    await closeTeamDetails(frame)
    await expect(main).toBeVisible()
  })

  test(`an 800px Run keeps its rail separate from explicitly selected inspection in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 800, height: 900 })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame, 'run')
    const main = frame.locator('[data-slot="workbench-main"]')
    const details = frame.locator('[data-slot="work-tools"]:visible')
    const opensOnFirstVisit = await details.count() > 0
    expect.soft(opensOnFirstVisit).toBe(false)
    if (opensOnFirstVisit) await closeRunInspector(frame)
    await expect(main).toBeVisible()
    await selectRunView(frame, 'Flow')
    const opensOnFlow = await details.count() > 0
    expect.soft(opensOnFlow).toBe(false)
    if (opensOnFlow) await closeRunInspector(frame)
    await expect(main).toBeVisible()
    await selectRunView(frame, 'Timeline')
    await expect(await teamDetails(frame)).toContainText('Seats')
    await expect(details).toHaveCount(0)
    await expect(main.locator('[data-step-row][data-selected="true"]')).toHaveCount(0)
    await closeTeamDetails(frame)
    await expect(await teamDetails(frame)).toContainText('Seats')
    await expect(details).toHaveCount(0)
    await closeTeamDetails(frame)
    await main.locator('[data-row][data-kind="card"]').first().click()
    await expect(details.locator('[data-slot="run-inspector"]')).toBeVisible()
    await expect(details.locator('[aria-label="Seats"]')).toHaveCount(0)
    await closeRunInspector(frame)
    await expect(await teamDetails(frame)).toContainText('Seats')
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `dock-800-after-${theme}.png`) })
    // Leave while the dock is open, then return at a width where it overlays.
    await page.setViewportSize({ width: 1440, height: 900 })
    await selectTeamPage(frame, 'room')
    await expect(details).toHaveCount(0)
    await expect(await teamDetails(frame)).toContainText('Seats')
    await page.setViewportSize({ width: 800, height: 900 })
    await selectTeamPage(frame, 'run')
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `return-800-after-${theme}.png`) })
    await expect(await teamDetails(frame)).toContainText('Seats')
    await closeTeamDetails(frame)
    await expect(main).toBeVisible()
    await expect(main.locator('[data-row="card-1-1"]')).toBeVisible()
  })

  test(`an older Run omits unrecorded facts and the narrow window uses the same dock in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 720, height: 900 })
    await page.goto(`/preview.html?run-dock&older&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame, 'run')
    await expect(frame.locator('[data-slot="dock-panel"][data-edge="left"]')).toHaveCount(0)
    const inspector = await teamDetails(frame)
    await expect(inspector.locator('[data-slot="summary-item"]').filter({ hasText: /^Budget/ })).toHaveCount(0)
    await expect(inspector).not.toContainText('Not recorded for this Run:')
    await expect(inspector.locator('[data-slot="summary-item"]').filter({ hasText: /^No progress/ })).toHaveCount(0)
    await expect(inspector).not.toContainText('no-progress limit')
    await expect(inspector.locator('[data-slot="summary-item"]').filter({ hasText: /^Seat cost/ })).toHaveCount(0)
    await inspector.getByRole('button', { name: 'Record details', exact: true }).click()
    const unknownCost = inspector.locator('[aria-label="Run record details"] [data-slot="summary-item"]').filter({ hasText: /^Seat cost/ })
    await expect(unknownCost).toHaveText('Seat costNot recorded')
    await expect(inspector).not.toContainText('Not recorded for this Run:')
    await expect(inspector.getByText('Seats', { exact: true })).toBeVisible()
    await expect(inspector.locator('[data-slot="card"]')).toHaveCount(0)
    expect(await inspector.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `older-narrow-after-${theme}.png`) })
    await closeTeamDetails(frame)
    await expect(frame.locator('[data-slot="workbench-main"]')).toBeVisible()
  })
}
