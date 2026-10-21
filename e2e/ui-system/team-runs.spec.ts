import { expectTitleRoom } from './title-contract'
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'
import { FRAME } from '../../packages/ui/src/design/frame'
import { closeTeamDetails, selectTeamPage, teamBar, teamDetails } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 800, 720]) {
    test(`trigger Runs keep their facts and gutter at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?team-frame=trigger-runs&theme=${theme}`)
      const team = page.locator('[data-slot="team-room"]')
      const frame=page.locator('[data-frame-id="team-frame"]')
      await selectTeamPage(frame,'runs')
      const runs = team.locator('[data-slot="team-runs"]')
      await expect(runs).toBeVisible()
      await expect(runs.locator('[data-run]')).toHaveCount(3)
      await expect(runs.locator('[data-run]').first()).toHaveAttribute('data-run', 'trigger-run-3')
      await expect(runs).toContainText('2 of 3 answered')
      await expect(runs).toContainText('2 findings')
      await expect(runs).toContainText('$6.00 of $20.00 daily cap')
      await expect(runs.locator('[data-slot="page-head"]')).toHaveCount(0)
      await expect(runs.getByRole('searchbox', { name: 'Filter Runs' })).toHaveCount(0)
      await expect(runs.getByRole('button', { name: 'Pause every trigger' })).toHaveCount(0)
      const facts=await teamDetails(frame)
      await expect(facts.locator('[data-slot="summary-item"]').filter({hasText:/^State/})).toContainText('Running')
      await closeTeamDetails(frame)
      await expect(runs).toContainText('interrupting its turns and checks')
      const geometry = await runs.evaluate(el => {
        const table = el.querySelector('table')!.getBoundingClientRect()
        const bounds = el.getBoundingClientRect()
        return { overflow: el.scrollWidth > el.clientWidth, left: table.left - bounds.left, right: bounds.right - table.right }
      })
      expect(geometry.overflow).toBe(false)
      expect(geometry.left).toBeGreaterThan(12)
      expect(geometry.right).toBeGreaterThan(12)
      const directory = process.env.TEAM_RUNS_SHOTS_DIR
      if (directory) {
        expect(textReasons(await page.evaluate(COLLECT), { user: USER })).toEqual([])
        mkdirSync(directory, { recursive: true })
        await page.evaluate(async () => { await document.fonts.ready })
        await page.screenshot({ path: `${directory}/after-runs-${width}-${theme}.png` })
      }
      await teamBar(frame).getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Pause every trigger', exact: true }).click()
      const paused=await teamDetails(frame)
      await expect(paused.locator('[data-slot="summary-item"]').filter({hasText:/^Trigger/})).toContainText('Paused')
      await expect(paused.locator('[data-slot="summary-item"]').filter({hasText:/^State/})).toContainText('Running')
      await closeTeamDetails(frame)
      await teamBar(frame).getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Resume every trigger', exact: true }).click()
      await expect((await teamDetails(frame)).locator('[data-slot="summary-item"]').filter({hasText:/^Trigger/})).toContainText('Armed')
      await closeTeamDetails(frame)
      await frame.locator('[data-slot="workbench-main"]').getByRole('button', { name: 'View', exact: true }).click()
      await page.getByRole('searchbox', { name: 'Filter Runs' }).fill('Run 2')
      await page.keyboard.press('Escape')
      await expect(runs.locator('[data-run]')).toHaveCount(1)
      await runs.getByRole('button', { name: 'Open Run 2: Retry checkout after a payment timeout' }).click()
      await expect(team.locator('[data-slot="run-view"]')).toBeVisible()
      await selectTeamPage(frame, 'runs')
      await frame.locator('[data-slot="workbench-main"]').getByRole('button', { name: 'View', exact: true }).click()
      await expect(page.getByRole('searchbox', { name: 'Filter Runs' })).toHaveValue('Run 2')
      await page.keyboard.press('Escape')
      await expect(runs.locator('[data-run]')).toHaveCount(1)
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`a docked Run keeps the Team title and header controls inside at 1440px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=trigger-runs&theme=${theme}`)
    const team = page.locator('[data-slot="team-room"]')
    const frame=page.locator('[data-frame-id="team-frame"]')
    await selectTeamPage(frame,'runs')
    const runs = team.locator('[data-slot="team-runs"]')
    await runs.locator('[data-run]').first().getByRole('button').click()
    await expect(team.locator('[data-slot="run-view"]')).toBeVisible()

    const header = teamBar(frame)
    const geometry = await header.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const title = element.querySelector<HTMLElement>('[data-topbar-title]')
      if (!title) throw new Error('The Team header has no subject')
      const style = getComputedStyle(title)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')!
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const text = title.textContent ?? ''
      const width = title.getBoundingClientRect().width
      let characters = 0
      for (let index = 1; index <= text.length; index += 1) {
        if (context.measureText(text.slice(0, index)).width > width) break
        characters = index
      }
      const buttons = [...element.querySelectorAll('button')].filter(button => button.getClientRects().length > 0)
      const buttonsInside = buttons.every(button => {
        const box = button.getBoundingClientRect()
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1
      })
      const source = element.querySelector<HTMLElement>('[data-team-trigger-source]')
      return { characters, buttonsInside, headerWidth: bounds.width, titleWidth: width,
        sourceDisplay: source ? getComputedStyle(source).display : 'missing' }
    })
    expect(geometry.characters, JSON.stringify(geometry)).toBeGreaterThanOrEqual(10)
    expect(geometry.buttonsInside).toBe(true)
    await expectTitleRoom(header.locator('[data-topbar-title]'))
    expect((await header.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)

    const directory = process.env.TEAM_RUNS_SHOTS_DIR
    if (directory) {
      expect(textReasons(await page.evaluate(COLLECT), { user: USER })).toEqual([])
      mkdirSync(directory, { recursive: true })
      await page.evaluate(async () => { await document.fonts.ready })
      await page.screenshot({ path: `${directory}/after-docked-run-1440-${theme}.png` })
    }
  })
}
