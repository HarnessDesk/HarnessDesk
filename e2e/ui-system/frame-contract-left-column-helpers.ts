import { expect, type Locator } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'




// Opening rows share icon/text edges; foldable headings start at the icon edge.
export const expectColumnRowEdges = async (rows: Locator, rowHeight: number = FRAME.rail.rowHeight) => {
  const values = await rows.evaluateAll(nodes => nodes.map(node => {
    const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
    const icon = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')
    const text = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!
    const words = button.querySelector<HTMLElement>('[data-left-fold-name]')
    const chevron = button.querySelector<SVGElement>('[data-slot="disclosure-chevron"]')
    return { h: button.getBoundingClientRect().height, text: text.getBoundingClientRect().x,
      icon: icon?.getBoundingClientRect().x ?? null, heading: button.hasAttribute('aria-expanded'),
      gap: words && chevron ? chevron.getBoundingClientRect().left - words.getBoundingClientRect().right : null }
  }))
  for (const row of values) expect(row.h).toBe(rowHeight)
  const opening = values.filter(row => !row.heading)
  expect(opening.length).toBeGreaterThan(2)
  for (const row of opening) expect(row.icon).not.toBeNull()
  for (const field of ['text', 'icon'] as const) {
    const xs = opening.map(row => row[field]!)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
  }
  for (const heading of values.filter(row => row.heading)) {
    expect(heading.icon, 'a foldable heading has its disclosure after the name').toBeNull()
    expect(Math.abs(heading.text - opening[0]!.icon!), 'heading starts on the icon edge').toBeLessThanOrEqual(1)
    expect(heading.gap, 'disclosure follows the name at the written 6px gap').toBeCloseTo(6, 1)
  }
  return opening
}
