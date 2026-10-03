import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`Run timeline ordering, selection fill and narrow geometry in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    const running = page.locator('#run-view-running [data-slot="run-view"]')
    await expect(running).toBeVisible()
    expect(await running.locator('[data-kind]').evaluateAll(rows => rows.map(row => row.getAttribute('data-kind')))).toEqual(['start', 'brief', 'round', 'card', 'round', 'check', 'round', 'card', 'findings', 'round', 'card'])
    const selected = running.locator('[data-row="card-3-3"]')
    await selected.click()
    await expect(selected).toHaveAttribute('aria-current', 'true')
    const colors = await selected.evaluate(el => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--hd-selected)'
      el.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { fill: getComputedStyle(el).backgroundColor, expected }
    })
    expect(colors.fill).toBe(colors.expected)
    const narrow = page.locator('#run-view-narrow [data-slot="run-view"]')
    const geometry = await narrow.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, overflowing: [...el.querySelectorAll('[data-row]')].some(row => row.scrollWidth > row.clientWidth + 1) }))
    expect(geometry.width).toBeLessThan(400)
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1)
    expect(geometry.overflowing).toBe(false)
    const leadDeltas = await narrow.locator('[data-row]:has([data-slot="list-row-lead"])').evaluateAll(rows => rows.map(row => {
      const lead = row.querySelector('[data-slot="list-row-lead"]')!.getBoundingClientRect()
      const walker = document.createTreeWalker(row.querySelector('[data-slot="list-row-title"]')!, NodeFilter.SHOW_TEXT)
      walker.nextNode()
      const range = document.createRange()
      range.selectNodeContents(walker.currentNode)
      const line = range.getClientRects()[0]!
      return Math.abs((lead.top + lead.bottom - line.top - line.bottom) / 2)
    }))
    expect(leadDeltas.every(delta => delta < 1.5)).toBe(true)
    await expect(narrow.getByText('Editing src/checkout/retry.ts')).toBeVisible()
    await expect(page.locator('#run-view-settled')).toContainText('Ended without a next step')
    await expect(page.locator('#run-view-stopped')).toContainText('Stopped by you')
    await expect(page.locator('#run-view-stalled')).toContainText('The desk stopped while the check ran')
    await expect(page.locator('#run-view-person')).toContainText('Needs you')
    await expect(page.locator('#run-view-pending')).toContainText('Reading checks and findings')
    await expect(page.locator('#run-view-failed')).toContainText('Some Run details could not be read')
    await expect(page.locator('#run-view-empty')).toContainText('No rounds have opened yet')
    const many = page.locator('#run-view-many [data-slot="run-scroll"]')
    expect(await many.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const rig = page.locator('#run-view-team')
    await rig.getByRole('button', { name: 'Run 1', exact: true }).click()
    await expect(rig.locator('[data-slot="run-view"]')).toBeVisible()
    await expect(rig.locator('[data-kind="end"]')).toContainText('Settled')
  })

  test(`Run findings keep damaged history visible at narrow width in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 390, height: 900 })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const findings = page.locator('#run-view-findings [data-kind="findings"]')
    await expect(findings).toContainText('Unreadable · The finding history has a missing sequence.')
    await expect(findings).toContainText('Repair claimed · awaiting review')
    await expect(findings).toContainText('Repair accepted by reviewer')
    const detail = findings.locator('[data-slot="run-detail"]')
    expect(await detail.evaluate(el => ({ clipped: el.scrollHeight > el.clientHeight + 1,
      overflow: el.scrollWidth > el.clientWidth + 1 }))).toEqual({ clipped: false, overflow: false })
  })
}
