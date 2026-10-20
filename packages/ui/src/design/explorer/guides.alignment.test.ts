import { afterEach, describe, expect, it } from 'vitest'
import { missesOf } from './guides'

const placed = (el: Element, left: number, kind: 'container' | 'control' = 'container') => ({
  el, r: new DOMRect(left, 0, 100, 24), kind,
})
const frame = (border = 1) => {
  const el = document.createElement('section')
  el.style.border = `${border}px solid black`
  document.body.append(el)
  const inner = Array.from({ length: 3 }, () => {
    const row = document.createElement('div')
    el.append(row)
    return placed(row, 100 + border)
  })
  return { outer: placed(el, 100), inner }
}
afterEach(() => document.body.replaceChildren())

describe('guide alignment around drawn borders', () => {
  it('keeps a descendant container on the exact inside of its ancestor’s drawn border', () => {
    const one = frame()
    expect(missesOf([one.outer, ...one.inner], { x: [100] })).toEqual([])
  })

  it('still diagnoses a descendant shifted one pixel past the drawn border inset', () => {
    const one = frame()
    const shifted = one.inner.map(row => ({ ...row, r: new DOMRect(102, 0, 100, 24) }))
    expect(missesOf([one.outer, ...shifted], { x: [100] }).map(one => one.box.el)).toEqual(shifted.map(one => one.el))
  })

  it('does not treat an unpainted ancestor as a border or excuse an inner control', () => {
    const one = frame()
    const control = document.createElement('button')
    one.outer.el.append(control)
    expect(missesOf([one.outer, placed(control, 101, 'control')], { x: [100] }).map(one => one.box.el)).toEqual([control])
    ;(one.outer.el as HTMLElement).style.borderColor = 'transparent'
    expect(missesOf([one.outer, ...one.inner], { x: [100] }).map(one => one.box.el)).toEqual(one.inner.map(one => one.el))
  })

  it('does not call a frame’s own border inset an off-line placement', () => {
    const one = frame()
    expect(missesOf([one.outer, ...one.inner], { x: [101] })).toEqual([])
  })

  it('keeps identical bordered peer frames on the same inner rail', () => {
    const one = frame(), two = frame()
    expect(missesOf([one.outer, ...one.inner, two.outer, ...two.inner], { x: [101] })).toEqual([])
  })

  it('still reports a one-pixel shift in an independent control', () => {
    const one = frame()
    const control = document.createElement('button')
    document.body.append(control)
    const shifted = placed(control, 102, 'control')
    expect(missesOf([one.outer, ...one.inner, shifted], { x: [101] }).map(one => one.box.el)).toEqual([control])
  })

  it('still reports a one-pixel shift in an independent sibling container', () => {
    const one = frame()
    const sibling = document.createElement('div')
    document.body.append(sibling)
    expect(missesOf([one.outer, ...one.inner, placed(sibling, 102)], { x: [101] }).map(one => one.box.el)).toEqual([sibling])
  })

  it('uses the rail’s half-pixel rounding for a quarter-pixel frame', () => {
    const one = frame()
    const outer = { ...one.outer, r: new DOMRect(100.25, 0, 100, 24) }
    const inner = one.inner.map(row => ({ ...row, r: new DOMRect(101.25, 0, 100, 24) }))
    const control = document.createElement('button')
    document.body.append(control)
    expect(missesOf([outer, ...inner, placed(control, 102.25, 'control')], { x: [101.5] }).map(one => one.box.el)).toEqual([control])
  })

  it('keeps a border miss when an independent sibling also owns the rail', () => {
    const one = frame()
    const sibling = document.createElement('div')
    document.body.append(sibling)
    expect(missesOf([one.outer, ...one.inner, placed(sibling, 101)], { x: [101] }).map(one => one.box.el)).toEqual([one.outer.el])
  })

  it('does not excuse a two-pixel displacement with a one-pixel border', () => {
    const one = frame()
    expect(missesOf([one.outer, ...one.inner.map(row => ({ ...row, r: new DOMRect(102, 0, 100, 24) }))], { x: [102] })
      .map(one => one.box.el)).toEqual([one.outer.el])
  })
})
