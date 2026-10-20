import { afterEach, describe, expect, it, vi } from 'vitest'

import { pulledInSlot, spillsOf } from './guides'

const box = (left: number, right: number, bottom = 20) => ({ left, right, bottom })

/** A row's control slot from 100 to 200, holding a control with the given inline margins. */
const slot = (margin: string) => {
  const el = document.createElement('span')
  el.dataset['slot'] = 'row-ctl'
  const control = document.createElement('button')
  control.setAttribute('style', `--edge-pull: -5px; background:transparent; border:0; ${margin}`)
  control.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
  el.append(control)
  document.body.append(el)
  return { el, control }
}

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('pulledInSlot', () => {
  it('lets a control pulled to the end cross the end by its pull, and not the start', () => {
    const { el, control } = slot('margin-right: -5px')
    const r = box(100, 200)
    expect(pulledInSlot(control, el, box(180, 205), r)).toBe(true)
    expect(pulledInSlot(control, el, box(180, 207), r)).toBe(false)
    expect(pulledInSlot(control, el, box(95, 120), r)).toBe(false)
  })

  it('lets a control pulled to the start cross the start by its pull, and not the end', () => {
    const { el, control } = slot('margin-left: -5px')
    const r = box(100, 200)
    expect(pulledInSlot(control, el, box(95, 120), r)).toBe(true)
    expect(pulledInSlot(control, el, box(93, 120), r)).toBe(false)
    expect(pulledInSlot(control, el, box(180, 205), r)).toBe(false)
  })

  it('uses the same bounded directional pull for an explicitly marked action slot', () => {
    const { el, control } = slot('margin-right: -5px')
    el.dataset['slot'] = 'action-slot'
    el.dataset['edgePullSlot'] = ''
    expect(pulledInSlot(control, el, box(180, 205), box(100, 200))).toBe(true)
    expect(pulledInSlot(control, el, box(180, 207), box(100, 200))).toBe(false)
    expect(pulledInSlot(control, el, box(95, 120), box(100, 200))).toBe(false)
  })

  it('grants nothing outside a row’s control slot', () => {
    const { el, control } = slot('margin-right: -5px')
    el.dataset['slot'] = 'toolbar'
    expect(pulledInSlot(control, el, box(180, 205), box(100, 200))).toBe(false)
  })

  it('keeps an unpainted icon hit target bounded by its declared pull through ancestor boxes', () => {
    const { el, control } = slot('margin-right: -5px')
    const message = document.createElement('div')
    el.replaceWith(message); message.append(el)
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    control.append(glyph)
    expect(pulledInSlot(control, message, box(180, 205), box(100, 200))).toBe(true)
    expect(pulledInSlot(control, message, box(180, 207), box(100, 200))).toBe(false)
    expect(pulledInSlot(glyph, message, box(198, 203), box(100, 200))).toBe(false)
    control.style.background = 'red'
    expect(pulledInSlot(control, message, box(180, 205), box(100, 200))).toBe(false)
    expect(pulledInSlot(control, el, box(180, 205), box(100, 200))).toBe(true)
    control.style.background = 'transparent'; control.textContent = 'Edit'
    expect(pulledInSlot(control, message, box(180, 205), box(100, 200))).toBe(false)
    expect(pulledInSlot(control, el, box(180, 205), box(100, 200))).toBe(true)
    control.textContent = ''; control.append(glyph); control.style.background = 'linear-gradient(red, blue)'
    expect(pulledInSlot(control, message, box(180, 205), box(100, 200))).toBe(false)
  })

  it('does not call an ancestor-transparent action a painted spill, and catches it when revealed', () => {
    const root = document.createElement('div'), actions = document.createElement('div'), control = document.createElement('button')
    actions.style.opacity = '0'; control.style.backgroundColor = 'red'
    actions.append(control); root.append(actions); document.body.append(root)
    const r = new DOMRect(0, 0, 200, 40), outside = new DOMRect(190, 0, 20, 20)
    vi.spyOn(actions, 'getBoundingClientRect').mockReturnValue(new DOMRect(180, 0, 20, 20))
    vi.spyOn(control, 'getBoundingClientRect').mockReturnValue(outside)
    Object.defineProperty(root, 'clientWidth', { value: 200 }); Object.defineProperty(root, 'scrollWidth', { value: 210 })
    const boxes = [{ el: root, r, kind: 'container' as const }]
    expect(spillsOf(boxes, r, root)).toEqual([])
    actions.style.opacity = '1'
    expect(spillsOf(boxes, r, root).map(one => one.how)).toEqual(['spills'])
    actions.style.visibility = 'hidden'; control.style.visibility = 'visible'
    expect(spillsOf(boxes, r, root).map(one => one.how)).toEqual(['spills'])
  })
})
