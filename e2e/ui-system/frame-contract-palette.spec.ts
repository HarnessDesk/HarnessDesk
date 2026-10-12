import { expect, test } from '@playwright/test'
import { WALL_THEMES } from './frame-wall-destinations'
import { mountFocusFixture } from './focus-ring-fixture'
import { resolvedPx } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


for (const theme of WALL_THEMES) for (const width of [1440, 720]) {
  test(`Palette result plate keeps the shared content edge inset at ${width} in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await mountFocusFixture(page)
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => {
      const store = (window as unknown as { __hdPreview: { store: { patch: (value: object) => void } } }).__hdPreview.store
      store.patch({
        history: [{
          id: 'flaky-check', runtime: 'sample-agent', title: 'Pin the flaky inventory check',
          preview: 'Inspect the repeated failure', cwd: '/work/storefront',
          status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 20,
        }],
        runtimes: [{
          id: 'sample-agent', name: 'Agent', presentation: { name: 'Agent' },
          capabilities: { searchHistory: false },
        }],
      })
    })
    await page.getByRole('button', { name: 'Open palette', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Command palette' })
    const field = panel.getByRole('searchbox')
    await expect(panel).toBeVisible()
    const emptyBounds = await panel.boundingBox()

    const measure = async () => {
      const bounds = await panel.boundingBox()
      if (!bounds) throw new Error('command palette has no box')
      const edges = await panel.evaluate(element => {
        const input = element.querySelector<HTMLInputElement>('input[type="search"]')!
        const group = element.querySelector<HTMLElement>('[data-menu-group]')!
        const icon = element.querySelector<HTMLElement>('[data-palette-result-icon]')!
        const title = element.querySelector<HTMLElement>('[data-palette-result-title]')!
        const meta = element.querySelector<HTMLElement>('[data-palette-result-meta]')!
        const textEdge = (node: HTMLElement) => node.getBoundingClientRect().x + parseFloat(getComputedStyle(node).paddingLeft)
        return {
          padding: parseFloat(getComputedStyle(element).paddingLeft),
          fieldText: textEdge(input),
          groupText: textEdge(group),
          rowIcon: icon.getBoundingClientRect().x,
          queryBorder: getComputedStyle(input).borderLeftWidth,
          titleInk: getComputedStyle(title).color,
          metaInk: getComputedStyle(meta).color,
          rowLeft: element.querySelector<HTMLElement>('[data-palette-result]')!.getBoundingClientRect().left,
          rowRight: element.querySelector<HTMLElement>('[data-palette-result]')!.getBoundingClientRect().right,
          metaRight: meta.getBoundingClientRect().right,
        }
      })
      return { bounds, edges }
    }

    const recent = panel.locator('[data-palette-result]').first()
    await recent.hover()
    const recentEdges = (await measure()).edges
    expect(recentEdges.fieldText).toBeCloseTo(recentEdges.groupText, 1)
    expect(recentEdges.fieldText).toBeCloseTo(recentEdges.rowIcon, 1)
    expect(recentEdges.rowIcon - recentEdges.rowLeft).toBeGreaterThanOrEqual(8)
    expect(recentEdges.rowRight - recentEdges.metaRight).toBeGreaterThanOrEqual(8)

    await field.fill('flaky')
    const result = panel.locator('[data-palette-result]')
    await expect(result).toContainText('flaky')
    await expect(panel.locator('[role="tab"]')).toHaveCount(5)
    await expect(panel.getByRole('button', { name: 'Include tool output' })).toBeVisible()
    await expect(panel).toContainText('Close')
    await expect(panel).toContainText('Change type')
    await expect(panel).toContainText('Open')

    const { bounds, edges } = await measure()
    expect(bounds.x + bounds.width / 2).toBeCloseTo(width / 2, 1)
    expect(bounds.y).toBeCloseTo(await resolvedPx(page, '--hd-space-6'), 1)
    expect(edges.padding).toBe(await resolvedPx(page, '--hd-space-6'))
    expect(edges.fieldText).toBeCloseTo(edges.groupText, 1)
    expect(edges.fieldText).toBeCloseTo(edges.rowIcon, 1)
    expect(edges.rowIcon - edges.rowLeft).toBeGreaterThanOrEqual(8)
    expect(edges.rowRight - edges.metaRight).toBeGreaterThanOrEqual(8)
    expect(edges.queryBorder).toBe('0px')
    expect(edges.titleInk).not.toBe(edges.metaInk)
    expect(edges.rowRight - edges.metaRight).toBeGreaterThanOrEqual(8)

    await field.fill('f')
    await expect.poll(async () => (await panel.boundingBox())?.y ?? -1).toBe(emptyBounds!.y)
    const typedBounds = await panel.boundingBox()
    expect(typedBounds?.x).toBe(emptyBounds?.x)
    expect(typedBounds?.y).toBe(emptyBounds?.y)
  })
}
