import { runBar, selectRunView } from './run-frame-actions'
import { expect, test } from '@playwright/test'
import path from 'node:path'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'
import { minimapOverlaps, zoomOf } from './canvas-minimap'
import { FRAME } from '../../packages/ui/src/design/frame'
import { closeTeamDetails, selectTeamDestination, selectTeamPage, teamBar, teamDetails, teamSeats } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`the docked Run Flow fills its pane and contains every step in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame,'run')
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

  test(`native narrow Run Flow keeps its Steps and geometry in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    // Native Flow content at the original 480–600px boundary keeps the same geometry floors.
    for (const width of [480, 520, 560, 600]) {
      await page.setViewportSize({ width, height: 700 })
      await page.goto(`/preview.html?run-dock&theme=${theme}`)
      const frame = page.locator('#run-dock-frame')
      await selectTeamDestination(frame,'run')
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
      // The responsive native list keeps its readable alternative in main.
      await expect.soft(list, `list at ${width}px`).toHaveAttribute('data-placement', 'below')
      expect.soft(await list.locator('[data-step-row]').count(), `step rows at ${width}px`).toBeGreaterThan(0)
      expect.soft((await list.locator('[data-step-row]').first().boundingBox())!.width, `step row at ${width}px`).toBeGreaterThan(200)
      // The drawing has the whole pane, not a strip scaled to its width, and holds every step.
      const drawn = (await canvas.boundingBox())!.height
      expect.soft(drawn, `canvas at ${width}px`).toBeGreaterThan(300)
      expect.soft((await main.locator('[data-slot="run-flow"]').boundingBox())!.height - drawn, `readable Steps at ${width}px`).toBeGreaterThan(0)
      expect.soft(await canvas.evaluate(el => {
        const clip = el.getBoundingClientRect()
        return [...el.querySelectorAll('.react-flow__node')].every(node => {
          const box = node.getBoundingClientRect()
          return box.top >= clip.top && box.bottom <= clip.bottom + 0.5 && box.left >= clip.left && box.right <= clip.right + 0.5
        })
      }), `steps at ${width}px`).toBe(true)
      // A drawn minimap never covers the title, the tools or a step.
      expect.soft(await minimapOverlaps(canvas), `minimap at ${width}px`).toEqual([])
    }
  })

  test(`Timeline keeps every original round and unreached Step when Details is put away in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    // The sidebar is a modal overlay below 1000px. Exercise its dismissal,
    // then explicitly put away any dock admitted after the sidebar closes.
    for (const width of [720, 780, 840]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(`/preview.html?run-dock&theme=${theme}`)
      const frame = page.locator('#run-dock-frame')
      await frame.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      await expect(frame.locator('[data-slot="workbench-scrim"]')).toBeVisible()
      await frame.locator('[data-slot="workbench-scrim"]').click()
      await expect(frame.locator('[data-slot="workbench-scrim"]')).toBeHidden()
      await selectTeamPage(frame,'run')
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
      // Timeline owns original recorded rounds and the unreached Step, with the same readable row floor.
      await expect(list, `Timeline at ${width}px`).toBeVisible()
      const rows = list.locator('[data-step-row][data-row]')
      await expect(rows).toHaveCount(4)
      expect.soft(await rows.count(), `step rows at ${width}px`).toBeGreaterThan(0)
      expect.soft(await rows.first().evaluate(el => el.getBoundingClientRect().width), `step row at ${width}px`).toBeGreaterThan(200)
      // The pane scrolls to the original rounds and unreached Step by wheel.
      const area = (await scroll.boundingBox())!
      await page.mouse.move(area.x + area.width / 2, area.y + area.height - 30)
      await page.mouse.wheel(0, 2000)
      await expect.poll(() => scroll.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1), `end of the pane at ${width}px`).toBe(true)
      await expect.soft(list.locator('[data-step-row="person"]'), `unreached Step at ${width}px`).toBeInViewport()
    }
  })

  test(`Timeline keeps its original Steps while Details or Activity occupies the panel in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    // Floating tools do not replace the main Timeline.
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame,'run')
    await selectRunView(frame, 'Timeline')
    const list = frame.locator('[data-slot="workbench-main"] [data-slot="run-steps"]')
    await teamDetails(frame)
    await expect(list, 'canonical Run facts do not hide the Steps').toBeVisible()
    await teamBar(frame).locator('[data-work-tool="activity"]').click()
    await expect(list, 'Activity does not own a readable Steps list').toBeVisible()
    await teamDetails(frame)
    await expect(list, 'returning to Details keeps the Steps readable').toBeVisible()
  })

  test(`Team Details keeps Run facts, Seats and selected inspection in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame,'run')
    const main = frame.locator('[data-slot="workbench-main"]')
    const summary = await teamDetails(frame)
    const facts=summary.locator('[aria-label="Team Run facts"]')
    await expect(facts).toContainText('#412')
    await expect(facts).toContainText('fix/checkout-502')
    await expect(facts).toContainText('3 of 24 rounds')
    await expect(facts).toContainText('1 of 3 rounds')
    await expect(summary.locator('[data-slot="card"]')).toHaveCount(0)
    await expect(summary.locator('[data-slot="run-inspector"]')).toHaveCount(0)
    await expect((await teamSeats(frame)).locator('[data-slot="list-row"]')).toHaveCount(2)
    const keyValues = await facts.evaluate(element => [...element.querySelectorAll('[data-slot="summary-item"]')].map(row => {
      const key=row.querySelector('dt')!.getBoundingClientRect()
      const value=row.querySelector('[data-slot="summary-value"]')!
      return { left: Math.round(value.getBoundingClientRect().left), key: Math.round(key.width), align:getComputedStyle(value).textAlign }
    }))
    expect(new Set(keyValues.map(value => value.left)).size).toBe(1)
    expect(keyValues.every(value => value.key===FRAME.summaryKey.panel && value.align==='left')).toBe(true)
    expect(await summary.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `details-after-${theme}.png`) })
    await summary.getByRole('button', { name: 'Flow file', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('This is the file as it is now.')
    await page.keyboard.press('Escape')
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
    await expect((await teamDetails(frame)).getByText('Seats', {exact:true})).toBeVisible()
    await selectRunView(frame, 'Timeline')
    await main.locator('[data-row="card-3-3"]').click()
    await expect(timelineSteps.locator('[data-row="card-3-3"]')).toHaveAttribute('data-selected', 'true')
    await selectRunView(frame, 'Flow')
    await expect(flowNode).toHaveAttribute('data-selected', 'true')
    await closeTeamDetails(frame)
    await main.locator('[data-step="person"]').click()
    await expect(main.locator('[data-step="person"]')).toHaveAttribute('data-selected','true')
    expect(await main.locator('[data-slot="run-flow"]').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if(process.env.RUN_DOCK_FRAMES_DIR)await frame.screenshot({path:path.join(process.env.RUN_DOCK_FRAMES_DIR,`steps-after-${theme}.png`)})
    await closeTeamDetails(frame)
    await teamBar(frame).getByRole('button',{name:'Toggle right panel',exact:true}).click()
    await expect(frame.locator('[data-slot="tool-body"]:visible')).toHaveCount(1)
    await expect(frame.locator('[data-slot="tool-body"]:visible')).toContainText('Seats')
    await closeTeamDetails(frame)
    await expect(main).toBeVisible()
  })

  test(`an 800px Run stays visible until its details are explicitly opened in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 800, height: 900 })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame,'run')
    const main = frame.locator('[data-slot="workbench-main"]')
    const details = frame.locator('[data-slot="tool-body"]:visible')
    const opensOnFirstVisit = await details.count() > 0
    expect.soft(opensOnFirstVisit).toBe(false)
    if (opensOnFirstVisit) await frame.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(main).toBeVisible()
    await selectRunView(frame, 'Flow')
    const opensOnFlow = await details.count() > 0
    expect.soft(opensOnFlow).toBe(false)
    if (opensOnFlow) await frame.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(main).toBeVisible()
    await selectRunView(frame, 'Timeline')
    await runBar(frame).getByRole('button', { name: 'Details', exact: true }).click()
    await expect(details).toBeVisible()
    await expect(details).toContainText('Seats')
    await expect(details.locator('[data-slot="run-inspector"]')).toHaveCount(0)
    await expect(main.locator('[data-step-row][data-selected="true"]')).toHaveCount(0)
    await closeTeamDetails(frame)
    await frame.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await expect(details).toBeVisible()
    await expect(details.locator('[data-slot="run-inspector"]')).toHaveCount(0)
    await closeTeamDetails(frame)
    await main.locator('[data-row][data-kind="card"]').first().click()
    await expect(details.locator('[data-slot="run-inspector"]')).toBeVisible()
    await expect(details.locator('[aria-label="Seats"]')).toBeVisible()
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `dock-800-after-${theme}.png`) })
    // Leave while the dock is open, then return at a width where it overlays.
    await page.setViewportSize({ width: 1440, height: 900 })
    await selectTeamPage(frame,'overview')
    await expect(details).toBeVisible()
    await expect(details.locator('[data-slot="run-inspector"]')).toHaveCount(0)
    await expect(details).toContainText('Seats')
    await page.setViewportSize({ width: 800, height: 900 })
    await selectTeamPage(frame,'run')
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `return-800-after-${theme}.png`) })
    await expect(details).toBeVisible()
    await closeTeamDetails(frame)
    await expect(main).toBeVisible()
    await expect(main.locator('[data-row="card-1-1"]')).toBeVisible()
  })

  test(`an older Run omits unrecorded facts and the narrow window uses the same dock in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 720, height: 900 })
    await page.goto(`/preview.html?run-dock&older&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await selectTeamPage(frame,'run')
    await expect(frame.locator('[data-slot="dock-panel"][data-edge="left"]')).toHaveCount(0)
    await frame.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    const inspector = frame.locator('[data-slot="tool-body"]:visible')
    await expect(inspector.locator('[data-slot="summary-item"]').filter({hasText:/^Budget/})).toHaveCount(0)
    await expect(inspector).toContainText('budget')
    await expect(inspector.locator('[data-slot="summary-item"]').filter({hasText:/^No progress/})).toHaveCount(0)
    await expect(inspector).toContainText('no-progress limit')
    await expect(inspector.locator('[data-slot="summary-item"]').filter({hasText:/^Seat cost/})).toHaveCount(0)
    await expect(inspector).toContainText('Seat costs')
    await expect(inspector).toContainText('Not recorded for this Run:')
    await expect(inspector.getByText('Seats',{exact:true})).toBeVisible()
    await expect(inspector.locator('[data-slot="card"]')).toHaveCount(0)
    expect(await inspector.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `older-narrow-after-${theme}.png`) })
    await closeTeamDetails(frame)
    await expect(frame.locator('[data-slot="workbench-main"]')).toBeVisible()
  })
}
