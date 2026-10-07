import type { Locator } from '@playwright/test'

/** What a drawn minimap sits on: the title or tools along the canvas's top edge, or a step. Empty when it is clear or not drawn. */
export const minimapOverlaps = (canvas: Locator) => canvas.evaluate(root => {
  const map = root.querySelector('.react-flow__minimap')
  const box = map?.getBoundingClientRect()
  if (!map || !box || !box.width || !box.height || getComputedStyle(map).display === 'none') return []
  const sitsOn = (other: Element) => {
    const one = other.getBoundingClientRect()
    return one.left < box.right && one.right > box.left && one.top < box.bottom && one.bottom > box.top
  }
  return [
    ...[...root.querySelectorAll('.react-flow__panel.top:not(.react-flow__minimap)')].filter(sitsOn).map(panel => `panel ${panel.textContent?.trim().slice(0, 24) || 'tools'}`),
    ...[...root.querySelectorAll<HTMLElement>('.react-flow__node')].filter(sitsOn).map(node => `step ${node.dataset.id}`),
  ]
})

/** A plan is fitted to a narrow pane once its zoom has left 100%; read it before judging where the minimap went. */
export const zoomOf = (canvas: Locator) => canvas.locator('.react-flow__viewport').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)
