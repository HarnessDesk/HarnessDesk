import { expect, test } from '@playwright/test'
import path from 'node:path'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'
import { minimapOverlaps, zoomOf } from './canvas-minimap'

for (const theme of ['light', 'dark'] as const) {
  test(`the docked Run Flow fills its pane and contains every step in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await frame.locator('[data-team-page="run"]').click()
    await frame.getByRole('radio', { name: 'Flow', exact: true }).click()
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

  test(`a narrow docked Run leaves its Steps to the dock and keeps the minimap clear in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    // A 950 to 1100px window with the dock open leaves the Run pane 440 to 600px wide.
    for (const width of [950, 1000, 1100]) {
      await page.setViewportSize({ width, height: 700 })
      await page.goto(`/preview.html?run-dock&theme=${theme}`)
      const frame = page.locator('#run-dock-frame')
      await frame.locator('[data-team-page="run"]').click()
      await frame.getByRole('radio', { name: 'Flow', exact: true }).click()
      const main = frame.locator('[data-slot="workbench-main"]')
        const canvas = main.locator('[data-slot="flow-canvas"]')
      const list = main.locator('[data-slot="flow-list"]')
      await expect(canvas.locator('.react-flow__node')).toHaveCount(4)
      await expect.poll(() => zoomOf(canvas)).toBeLessThan(0.6)
      if (process.env.FLOW_DOCK_FRAMES_DIR && width !== 950) {
        await page.evaluate(async () => { await document.fonts.ready })
        expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
        await frame.screenshot({ path: path.join(process.env.FLOW_DOCK_FRAMES_DIR, `round5-run-dock-${width}-${theme}-${process.env.FLOW_DOCK_FRAME_PHASE ?? 'after'}.png`) })
      }
      // The dock lists the Steps, so the pane keeps only the text alternative, which takes no room.
      await expect.soft(list, `list at ${width}px`).toHaveAttribute('data-placement', 'dock')
      expect.soft(await list.evaluate(el => { const box = el.getBoundingClientRect(); return box.width <= 1 && box.height <= 1 }), `list at ${width}px`).toBe(true)
      // The drawing has the whole pane, not a strip scaled to its width, and holds every step.
      const drawn = (await canvas.boundingBox())!.height
      expect.soft(drawn, `canvas at ${width}px`).toBeGreaterThan(300)
      expect.soft((await main.locator('[data-slot="run-flow"]').boundingBox())!.height - drawn, `canvas at ${width}px`).toBeLessThan(2)
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

  test(`Run details and Steps use the workbench dock in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await frame.locator('[data-team-page="run"]').click()
    const main = frame.locator('[data-slot="workbench-main"]')
    const dock = frame.locator('[data-slot="dock-panel"][data-edge="left"]')
    await expect(dock).toBeVisible()
    await expect(main.locator('[data-slot="run-inspector"]')).toHaveCount(0)
    await expect(dock.getByRole('tab', { name: 'Run details', exact: true })).toHaveAttribute('aria-selected', 'true')
    const summary = dock.locator('[data-slot="run-inspector"]')
    await expect(summary).toContainText('Pull request #412')
    await expect(summary).toContainText('fix/checkout-502')
    await expect(summary).toContainText('1 failed·1 passed')
    await expect(summary).toContainText('3 of 24 rounds')
    await expect(summary.locator('[data-slot="inspector-row-mark"]')).toHaveCount(2)
    await expect(summary.locator('[data-slot="card"]')).toHaveCount(4)
    await expect(summary.getByRole('progressbar', { name: 'Budget', exact: true })).toHaveAttribute('aria-valuenow', '3')
    await expect(summary.getByRole('progressbar', { name: 'Without progress', exact: true })).toHaveAttribute('aria-valuemax', '3')
    await expect(summary.locator('[data-slot="card-title"] [data-slot="chip"][data-tone="success"]')).toHaveText('Open')
    const keyValues = await summary.evaluate(element => {
      const rows = [...element.querySelectorAll('[data-slot="key-value-row"]')]
      return rows.map(row => {
        const value = row.querySelector(':scope > dd')!
        return { left: Math.round(value.getBoundingClientRect().left), align: getComputedStyle(value).textAlign,
          numeric: row.hasAttribute('data-numeric') }
      })
    })
    expect(new Set(keyValues.map(value => value.left)).size).toBe(1)
    expect(keyValues.every(value => value.align === 'left' && !value.numeric)).toBe(true)
    const brief = summary.locator('[data-slot="card"]').first()
    const header = brief.locator('[data-slot="card-header"]')
    const prose = brief.locator('[data-slot="card-content"]')
    expect(Math.abs((await header.boundingBox())!.x - (await prose.boundingBox())!.x)).toBeLessThan(1)
    expect(await brief.evaluate(el => {
      const card = el.getBoundingClientRect()
      const body = el.querySelector('[data-slot="card-content"]')!.getBoundingClientRect()
      return body.x - card.x
    })).toBeGreaterThan(0)
    expect(await summary.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `details-after-${theme}.png`) })
    await summary.getByRole('button', { name: 'Flow file', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('This is the file as it is now.')
    await page.keyboard.press('Escape')
    await frame.getByRole('radio', { name: 'Flow', exact: true }).click()
    await expect(dock.getByRole('tab', { name: 'Steps', exact: true })).toHaveAttribute('aria-selected', 'true')
    const steps = dock.locator('[data-slot="run-steps"]')
    await expect(steps).toContainText('Taken 4')
    await expect(steps).toContainText('Not reached 1')
    await expect(steps.locator('[data-step-row]')).toHaveCount(5)
    await expect(steps.locator('[data-slot="chip"][data-tone="info"]')).toHaveText('Working')
    await expect(steps.locator('[data-slot="chip"][data-tone="warning"]')).toHaveText('Request changes')
    const flowRow = main.locator('[data-step-row="reviewer"]')
    const dockRow = steps.locator('[data-step-row="reviewer"]')
    await expect(dockRow.locator('[data-slot="chip"][data-tint]')).toHaveText(await flowRow.locator('[data-slot="chip"][data-tint]').innerText())
    await expect(dockRow.locator('[data-slot="icon-tile"]')).toHaveAttribute('data-tint', (await flowRow.locator('[data-slot="icon-tile"]').getAttribute('data-tint'))!)
    await expect(dockRow.locator('[data-slot="list-row-subtitle"]')).toHaveText('Round 3')
    await expect(dockRow.locator('[data-slot="list-row-trail"]')).toContainText('1 run')
    await expect(steps.locator('[data-selected]')).toContainText('Round 4')
    await steps.getByRole('button').filter({ hasText: 'Round 3' }).click()
    await expect(main.locator('[data-step="reviewer"]')).toHaveAttribute('data-selected', 'true')
    await steps.getByRole('button').filter({ hasText: 'Not reached' }).click()
    await expect(main.locator('[data-step="person"]')).toHaveAttribute('data-selected', 'true')
    expect(await steps.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `steps-after-${theme}.png`) })
    await dock.getByRole('button', { name: 'Give this panel the whole area', exact: true }).click()
    await expect(main).toBeHidden()
    await expect(steps).toBeVisible()
    await dock.getByRole('button', { name: 'Back to the layout', exact: true }).click()
    await expect(main).toBeVisible()
    await frame.getByRole('button', { name: 'Hide the right panel', exact: true }).click()
    await expect(dock).toHaveCount(0)
    await frame.getByRole('button', { name: 'Show the right panel — 2 views', exact: true }).click()
    await expect(frame.locator('[data-slot="run-steps"]')).toBeVisible()
  })

  test(`an 800px Run stays visible until its details are explicitly opened in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 800, height: 900 })
    await page.goto(`/preview.html?run-dock&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await frame.locator('[data-team-page="run"]').click()
    const main = frame.locator('[data-slot="workbench-main"]')
    const dock = frame.locator('[data-slot="dock-panel"][data-edge="left"]')
    const opensOnFirstVisit = await dock.count() > 0
    expect.soft(opensOnFirstVisit).toBe(false)
    if (opensOnFirstVisit) await frame.getByRole('button', { name: 'Hide the right panel', exact: true }).click()
    await expect(main).toBeVisible()
    await frame.getByRole('radio', { name: 'Flow', exact: true }).click()
    const opensOnFlow = await dock.count() > 0
    expect.soft(opensOnFlow).toBe(false)
    if (opensOnFlow) await frame.getByRole('button', { name: 'Hide the right panel', exact: true }).click()
    await expect(main).toBeVisible()
    await frame.getByRole('radio', { name: 'Timeline', exact: true }).click()
    await main.locator('[data-row="round-1"]').click()
    await expect(dock).toBeVisible()
    await expect(dock.getByRole('tab', { name: 'Run details', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(main.locator('[data-row="round-1"]')).toHaveAttribute('aria-current', 'true')
    await dock.getByRole('button', { name: 'Hide this panel', exact: true }).click()
    await frame.getByRole('button', { name: 'Run details', exact: true }).click()
    await expect(dock).toBeVisible()
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `dock-800-after-${theme}.png`) })
    // Leave while the dock is open, then return at a width where it overlays.
    await page.setViewportSize({ width: 1440, height: 900 })
    await frame.locator('[data-team-page="overview"]').click()
    await expect(dock).toHaveCount(0)
    await page.setViewportSize({ width: 800, height: 900 })
    await frame.locator('[data-team-page="run"]').click()
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `return-800-after-${theme}.png`) })
    await expect(main).toBeVisible()
    await expect(dock).toHaveCount(0)
  })

  test(`an older Run omits unrecorded facts and the narrow window uses the same dock in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 680, height: 900 })
    await page.goto(`/preview.html?run-dock&older&theme=${theme}`)
    const frame = page.locator('#run-dock-frame')
    await frame.locator('[data-team-page="run"]').click()
    await expect(frame.locator('[data-slot="dock-panel"][data-edge="left"]')).toHaveCount(0)
    await frame.getByRole('button', { name: 'Show the right panel — 2 views', exact: true }).click()
    const inspector = frame.locator('[data-slot="run-inspector"]:visible')
    await expect(inspector.locator('[data-slot="run-recording-gaps"]')).toContainText('base, budget, Seat details, Seat costs')
    await expect(inspector.locator('[data-slot="card-title"]').filter({ hasText: /^Seats/ })).toHaveCount(0)
    await expect(inspector).not.toContainText('Not recorded')
    expect(await inspector.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    if (process.env.RUN_DOCK_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.RUN_DOCK_FRAMES_DIR, `older-narrow-after-${theme}.png`) })
    await frame.getByRole('button', { name: 'Hide this panel', exact: true }).click()
    await expect(frame.locator('[data-slot="workbench-main"]')).toBeVisible()
  })
}
