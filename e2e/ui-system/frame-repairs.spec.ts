import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES, WALL_TIME, WALL_WIDTHS } from './frame-wall-destinations'

const openTeam = async (page: Page, theme: 'light' | 'dark', width: number, tab: string) => {
  await page.clock.setFixedTime(WALL_TIME)
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  // The default wall scene has no finding round; select the existing
  // posting scene so the real Findings page includes its mixed facts card.
  await page.route('**/src/preview/frames-frame-wall.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const body = source.replace(/overviewTeamStore\(["']running["']\)/g, `(() => {
      const store = overviewTeamStore("findings-and-posting");
      const snapshot = store.getSnapshot();
      for (const [id, run] of snapshot.flowExecutions) snapshot.flowExecutions.set(id, { ...run,
        findings: { version: 1, budget: { rounds: 3, withoutProgress: 2 }, closedRounds: [], idleRounds: 0,
          progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null } });
      return store;
    })()`)
    if (body === source) throw new Error('frame wall scene was not found')
    await route.fulfill({ response, body })
  })
  await page.goto(`/preview.html?frame-wall=team&theme=${theme}`)
  await page.locator(`[data-team-page="${tab}"]`).first().click()
  await page.evaluate(() => document.fonts.ready)
}

const capture = async (page: Page, name: string) => {
  const directory = process.env.FRAME_REPAIR_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  await page.screenshot({ path: path.join(directory, name) })
}

for (const theme of WALL_THEMES) {
  test(`all page widths keep their own inset and measure in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    // Supply content through the explorer's existing fixture seam; the Page
    // components and cascade come from the real design system.
    await page.route('**/src/design/explorer/main.tsx*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      const reactUrl = /from ['"]([^'"\n]*\/react\.js[^'"\n]*)['"]/.exec(source)?.[1]
      if (!reactUrl) throw new Error('explorer React module import was not found')
      await route.fulfill({ response, body: `${source}
        import fixtureReact from ${JSON.stringify(reactUrl)};
        import { Page } from '/src/design/index.ts';
        document.getElementById('root').hidden = true;
        const frame = document.createElement('div');
        document.body.append(frame);
        const h = fixtureReact.createElement;
        createRoot(frame).render(h('div', null, ...['reading', 'wide', 'canvas'].map(width =>
          h(Page, { width, key: width }, h('p', null, 'Checkout review')))));
      ` })
    })
    await page.goto(`/design.html?theme=${theme}`)
    await expect(page.locator('[data-slot="page"]')).toHaveCount(3)
    const measured = []
    for (const width of WALL_WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      const pages = await page.locator('[data-slot="page"]').evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        const parent = element.parentElement!.getBoundingClientRect()
        return {
          kind: element.getAttribute('data-width'),
          gutters: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat),
          width: box.width,
          available: parent.width,
          margins: [box.left - parent.left, parent.right - box.right],
        }
      }))
      await capture(page, `pages-${width}-${theme}.png`)
      measured.push({ width, pages })
    }
    for (const { width, pages } of measured) {
      for (const page of pages) {
        const gutter = page.kind === 'canvas' ? FRAME.page.canvasGutter : FRAME.page.gutter
        expect(page.gutters, `${page.kind} at ${width}`).toEqual(Array(4).fill(gutter))
        const cap = page.kind === 'reading' ? FRAME.page.reading + 2 * gutter
          : page.kind === 'wide' ? FRAME.page.wide + 2 * gutter : page.available
        expect(page.width).toBe(Math.min(page.available, cap))
        expect(Math.abs(page.margins[0]! - page.margins[1]!)).toBeLessThanOrEqual(1)
      }
    }
  })

  for (const width of WALL_WIDTHS) {
    test(`Findings counts start beside the key at ${width} in ${theme}`, async ({ page }) => {
      await openTeam(page, theme, width, 'findings')
      const facts = page.locator('dl[aria-label="This round"]')
      await expect(facts).toBeVisible()
      await capture(page, `team-findings-${width}-${theme}.png`)
      const rows = await facts.locator('[data-slot="summary-item"]').evaluateAll(items => items.map(item => {
        const value = item.querySelector('[data-slot="summary-value"]')!
        const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT)
        const text = walker.nextNode()!
        const range = document.createRange()
        range.selectNodeContents(text)
        return {
          label: item.querySelector('dt')!.textContent,
          align: getComputedStyle(value).textAlign,
          start: range.getBoundingClientRect().left,
          edge: value.getBoundingClientRect().left,
        }
      }))
      const count = rows.find(row => row.label === 'Open findings')!
      expect(count.align).toBe('left')
      expect(Math.abs(count.start - count.edge)).toBeLessThanOrEqual(1)
      expect(Math.abs(count.start - rows[0]!.start)).toBeLessThanOrEqual(1)
    })
  }
}
