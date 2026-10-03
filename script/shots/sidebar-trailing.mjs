#!/usr/bin/env node
// pnpm's UI dev server supplies the real catalogue and its synthetic store.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { measureSidebarRail } from '../../e2e/ui-system/sidebar-rail.mjs'
import { COLLECT, textReasons, USER, TILDIFY } from './audit.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback
const origin = flag('origin', 'http://127.0.0.1:5719')
const output = resolve(flag('out', 'output/playwright/sidebar-trailing-yield'))
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const measurements = []
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1500 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
    await page.goto(`${origin}/design.html?view=sidebar`)
    await page.evaluate(TILDIFY('/Users/shane/code/HarnessDesk/.claude/worktrees', '/work/checkouts'))
    await page.evaluate(TILDIFY('~/.codex/worktrees', '/work/checkouts'))
    const sidebar = page.locator('[data-catalog-example="sidebar"] [data-region="sidebar-header"]').first()
      .locator('xpath=ancestor::div[contains(@class,"sidebar_")][last()]')
    const room = sidebar.getByRole('button', { name: 'Room Finish the checkout boundary', exact: true })
    const approval = sidebar.locator('[aria-label="Room Approve the migration evidence"][data-held]')
    const row = room.locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
    for (const width of [200, 260, 320, 540]) {
      await sidebar.evaluate((node, width) => {
        Object.assign(node.parentElement.style, { width: `${width + 2}px`, maxWidth: 'none', height: '1280px' })
        node.style.width = '100%'
      }, width)
      await sidebar.scrollIntoViewIfNeeded()
      await sidebar.locator('[data-region="sidebar-content"]').evaluate(node => { node.scrollTop = 0 })
      const capture = async state => {
        await page.evaluate(TILDIFY('/Users/shane/code/HarnessDesk/.claude/worktrees', '/work/checkouts'))
        assert.deepEqual(textReasons(await page.evaluate(COLLECT), { user: USER }), [], 'frame privacy audit')
        const measured = await sidebar.evaluate(measureSidebarRail)
        assert.ok(measured.rail <= measured.sidebarRight - 20, 'visible rail must be inset')
        for (const item of measured.rows) {
          if (item.targetRight !== null) assert.ok(Math.abs(item.targetRight - measured.targetRail) <= 0.5, `${item.name}: target rail`)
          if (!item.chipBox) continue
          assert.ok(Math.abs(item.chipBox.right - item.chipRail) <= 0.5, `${item.name}: chip misses visible rail`)
          assert.ok(Math.abs(item.textBox.right - item.chipRail) <= 0.5, `${item.name}: text misses visible rail`)
          assert.deepEqual(item.chipStyle, { background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none', paddingLeft: '0px', paddingRight: '0px' }, `${item.name}: quiet text`)
          assert.ok(item.textBox.left >= item.chipBox.left - 0.5 && item.textBox.right <= item.chipBox.right + 0.5, `${item.name}: clipped text`)
          assert.ok(item.chipBox.left >= item.clip.left && item.chipBox.right <= item.clip.right && item.chipBox.top >= item.clip.top && item.chipBox.bottom <= item.clip.bottom, `${item.name}: clipped chip`)
        }
        measurements.push({ theme, width, state, ...measured })
        await sidebar.screenshot({ path: `${output}/${theme}-${width}-${state}.png` })
      }
      await page.mouse.move(1439, 0)
      await page.evaluate(() => document.activeElement?.blur())
      await capture('rest')
      if (width === 200) {
        const session = sidebar.locator('[data-region="session-row"] [data-slot="sidebar-menu-item"]')
          .filter({ hasText: 'Pin the flaky inventory test after reconciling every retry branch' })
        await session.screenshot({ path: `${output}/${theme}-200-approval-title.png` })
      }
      const hover = async button => {
        await button.hover()
        const owner = button.locator('xpath=ancestor::li[@data-slot="sidebar-menu-item"][1]')
        const actions = owner.locator(':scope > [data-slot="sidebar-menu-action"], :scope > div > [data-slot="sidebar-menu-action"]')
        for (const action of await actions.all()) await action.waitFor({ state: 'visible' })
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().endTime === Infinity))
        assert.ok((await actions.evaluateAll(nodes => nodes.every(node => getComputedStyle(node).opacity === '1'))), 'hover actions must be opaque')
      }
      await hover(room)
      await capture('hover-room')
      const toggle = row.locator(':scope > div > [data-slot="sidebar-menu-action"]')
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
      await hover(row.locator('[data-nested="true"] [data-region="session-row"] [data-slot="sidebar-menu-button"]').first())
      await capture('hover-member')
      await hover(approval)
      await capture('hover-needs-you')
    }
    await page.close()
  }
  await writeFile(`${output}/measurements.json`, `${JSON.stringify(measurements, null, 2)}\n`)
  console.log(`34 audited sidebar frames; every row measured against the visible session dot rail`)
} finally {
  await browser.close()
}
