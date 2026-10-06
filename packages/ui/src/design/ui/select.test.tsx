import { Select as SelectPrimitive } from '@base-ui/react/select'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Select, SelectScrollDownButton, SelectScrollUpButton } from './select'

it('mirrors one caret for both scroll directions', () => {
  const box = document.createElement('div')
  box.innerHTML = renderToStaticMarkup(<Select open><SelectPrimitive.Positioner><SelectPrimitive.Popup><SelectScrollUpButton keepMounted /><SelectScrollDownButton keepMounted /></SelectPrimitive.Popup></SelectPrimitive.Positioner></Select>)
  const up = box.querySelector('[data-slot="select-scroll-up-button"] svg')!
  const down = box.querySelector('[data-slot="select-scroll-down-button"] svg')!
  expect(up.classList.contains('lucide-chevron-down')).toBe(true)
  expect(up.classList.contains('rotate-180')).toBe(true)
  expect(down.classList.contains('lucide-chevron-down')).toBe(true)
})


it('insets scroll arrows from the popup edges over an opaque surface', () => {
  const box = document.createElement('div')
  box.innerHTML = renderToStaticMarkup(<Select open><SelectPrimitive.Positioner><SelectPrimitive.Popup><SelectScrollUpButton keepMounted /><SelectScrollDownButton keepMounted /></SelectPrimitive.Popup></SelectPrimitive.Positioner></Select>)
  for (const [direction, edge] of [['up', 'top-1'], ['down', 'bottom-1']] as const) {
    const arrow = box.querySelector(`[data-slot="select-scroll-${direction}-button"]`)!
    expect(arrow.classList.contains(edge)).toBe(true)
    expect(arrow.classList.contains('inset-x-1')).toBe(true)
    expect(arrow.classList.contains('bg-popover')).toBe(true)
  }
})
