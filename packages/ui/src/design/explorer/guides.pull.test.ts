import { afterEach, describe, expect, it } from 'vitest'

import { pulledInSlot } from './guides'

const box = (left: number, right: number, bottom = 20) => ({ left, right, bottom })

/** A row's control slot from 100 to 200, holding a control with the given inline margins. */
const slot = (margin: string) => {
  const el = document.createElement('span')
  el.dataset['slot'] = 'row-ctl'
  const control = document.createElement('button')
  control.setAttribute('style', `--edge-pull: -5px; ${margin}`)
  el.append(control)
  document.body.append(el)
  return { el, control }
}

afterEach(() => { document.body.replaceChildren() })

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

  it('grants nothing outside a row’s control slot', () => {
    const { el, control } = slot('margin-right: -5px')
    el.dataset['slot'] = 'toolbar'
    expect(pulledInSlot(control, el, box(180, 205), box(100, 200))).toBe(false)
  })
})
