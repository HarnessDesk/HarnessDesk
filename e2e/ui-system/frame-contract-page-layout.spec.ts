import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { applyFrameActions } from './frame-actions'
import { openFrame, resolvedPx, layoutDestinations } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()



for (const theme of WALL_THEMES) for (const destination of ['settings', 'agents', 'teams', 'dashboard']) {
  test(`Owner fix 2 ${destination} has one shell bar and no footer in ${theme}`, async ({ page }) => {
    await openFrame(page, `frame-wall=${destination}`, theme, 720)
    const destinationPage = page.locator(`[data-page-destination="${destination}"]:visible`)
    await expect(destinationPage).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await expect(bar).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"], [data-frame-region="status"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
    expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(bar.getByRole('button', { name: 'More', exact: true })).toHaveCount(0)
    const lead = bar.getByRole('button', { name: 'Show sidebar', exact: true })
    await lead.focus()
    await expect(lead).toBeFocused()
    await page.keyboard.press('Meta+w')
    await expect(destinationPage).toHaveCount(0)
    await expect(page.locator('[data-slot="top-bar"]:visible')).toHaveCount(1)
    await expect(page.locator('[data-slot="status-bar"]:visible')).toHaveCount(0)
  })
}

test('FIX3 page section headings share one page text edge', async ({ page }) => {
  const destinations = [
    ['Settings', 'frame-wall=settings&frame-section=runtimes'],
    ['Dashboard overview', 'frame-wall=dashboard&frame-view=overview'],
    ['Dashboard plans', 'frame-wall=dashboard&frame-view=plans'],
    ['Dashboard spend', 'frame-wall=dashboard&frame-view=spend'],
    ['Dashboard activity', 'frame-wall=dashboard&frame-view=activity'],
    ['Dashboard projects', 'frame-wall=dashboard&frame-view=projects'],
    ['Agents', 'frame-wall=agents'],
    ['Library', 'frame-wall=library'],
    ['Plugins', 'frame-wall=plugins&frame-plugin-page=installed'],
    ['Teams', 'frame-wall=teams&frame-filter=active'],
    ['Review', 'frame-wall=changes-review'],
  ] as const
  for (const [name, query] of destinations) {
    await openFrame(page, query, 'light', 1440)
    const offsets = await page.locator('[data-section-head] h2, [data-slot="section-head"] h2').evaluateAll(headings =>
      headings.filter(heading => heading.getClientRects().length).map(heading => {
        const columns = heading.closest('[data-slot="dashboard-columns"]')
        const column = columns && [...columns.children].findIndex(child => child.contains(heading))
        return { group: columns ? `column-${column}` : 'page', left: Math.round(heading.getBoundingClientRect().left * 2) / 2 }
      }),
    )
    for (const group of new Set(offsets.map(item => item.group))) {
      const groupOffsets = offsets.filter(item => item.group === group).map(item => item.left)
      expect(Math.max(...groupOffsets) - Math.min(...groupOffsets), `${name} ${group} headings share one text edge: ${groupOffsets.join(', ')}`).toBeLessThanOrEqual(1)
    }
  }
})

for (const destination of layoutDestinations) {
  test(`shared heading and page or panel stacks hold across preview destinations: ${destination.id}`, async ({ page }) => {
    await openFrame(page, destination.query, 'light', 1440)
    const stackGap = await resolvedPx(page, '--hd-card-gap')
    await applyFrameActions(page, destination)
    if (destination.id === 'settings-runtimes-add') {
      await page.getByRole('button', { name: 'Add a runtime', exact: true }).click()
      await expect(page.getByRole('searchbox', { name: 'Search the ACP registry' })).toBeVisible()
    }
    const issues = await page.evaluate(minimum => {
      const failures: string[] = []
      for (const head of document.querySelectorAll<HTMLElement>('[data-section-head], [data-slot="section-head"]')) {
        const name = head.querySelector<HTMLElement>('[data-slot="section-name"], [data-section-name]')
        const action = head.querySelector<HTMLElement>('[data-slot="section-action"]')
        if (!name || !action || !name.getClientRects().length || !action.getClientRects().length) continue
        const one = name.getBoundingClientRect(), two = action.getBoundingClientRect()
        if (one.left < two.right && two.left < one.right && one.top < two.bottom && two.top < one.bottom) {
          failures.push(`heading overlaps its control: ${name.textContent?.trim() ?? 'section'}`)
        }
      }
      const selector = [
        '[data-slot="rows"]', '[data-slot="card"]', '[data-slot="summary-list"]',
        '[data-slot="note"]', '[data-slot="banner"]', '[data-slot="search"]',
        '[data-slot="table-container"]', '[data-slot="tool-pane-message"]',
        '[data-slot="tool-pane-empty"]', '[data-slot="inspector-empty"]',
        '[data-slot="section"][data-variant="card"]', '[data-slot="section"][data-variant="quiet"]',
        '[data-slot="section"][data-variant="panel"]',
      ].join(',')
      const roots = document.querySelectorAll<HTMLElement>(
        '[data-slot="page"], [data-slot="tool-pane-body"], [data-slot="inspector-body"], [data-slot="section"][data-variant="panel"]',
      )
      for (const root of roots) {
        const candidates = [...root.querySelectorAll<HTMLElement>(selector)].filter(node => {
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && !node.parentElement?.closest(selector)
        })
        for (let index = 0; index < candidates.length; index++) for (let next = index + 1; next < candidates.length; next++) {
          const a = candidates[index]!.getBoundingClientRect(), b = candidates[next]!.getBoundingClientRect()
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          const gapY = a.bottom <= b.top ? b.top - a.bottom : b.bottom <= a.top ? a.top - b.bottom : null
          const gapX = a.right <= b.left ? b.left - a.right : b.right <= a.left ? a.left - b.right : null
          const gap = overlapX > 0 ? gapY : overlapY > 0 ? gapX : null
          if (gap !== null && gap < minimum - 0.5) {
            failures.push(`adjacent surfaces are ${gap.toFixed(1)}px apart (${candidates[index]!.dataset['slot']} / ${candidates[next]!.dataset['slot']})`)
          }
        }
      }
      return [...new Set(failures)]
    }, stackGap)
    expect(issues, `${destination.id} violates a shared layout rule`).toEqual([])

  })
}

test('shared heading and page or panel stacks: Dashboard at 720', async ({ page }) => {
await openFrame(page, 'frame-wall=dashboard', 'light', 720)
const dashboardIssues = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-section-head]')].flatMap(head => {
    const name = head.querySelector<HTMLElement>('[data-slot="section-name"]')
    const action = head.querySelector<HTMLElement>('[data-slot="section-action"]')
    if (!name || !action || !name.getClientRects().length || !action.getClientRects().length) return []
    const one = name.getBoundingClientRect(), two = action.getBoundingClientRect()
    return one.left < two.right && two.left < one.right && one.top < two.bottom && two.top < one.bottom
      ? [`${name.textContent?.trim() ?? 'section'} overlaps its control`] : []
  }))
expect(dashboardIssues, 'Dashboard section headings must remain clear of their controls when narrow').toEqual([])
})

test('shared heading and page or panel stacks: registry search gap', async ({ page }) => {
await openFrame(page, 'frame-wall=settings-runtimes&layout-registry=1', 'light', 1440)
const stackGap = await resolvedPx(page, '--hd-card-gap')
await page.getByRole('button', { name: 'Add a runtime', exact: true }).click()
const search = page.locator('[data-slot="search"]').filter({ has: page.getByRole('searchbox', { name: 'Search the ACP registry' }) })
await expect(search).toBeVisible()
const searchBottom = (await search.boundingBox())!.y + (await search.boundingBox())!.height
const firstRegistryRows = page.locator('[data-page-destination="settings"]:visible [data-slot="rows"]:visible').filter({has:page.getByText('Runtime 01',{exact:true})})
await expect(firstRegistryRows).toBeVisible()
const firstRegistryBox = (await firstRegistryRows.boundingBox())!
expect(firstRegistryBox.y - searchBottom).toBeGreaterThanOrEqual(stackGap - 0.5)
})
