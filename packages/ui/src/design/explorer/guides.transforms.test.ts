import { afterEach, describe, expect, it } from 'vitest'
import { missesOf, railsOf } from './guides'

const placed = (el: Element, left: number, width = 20, kind: 'container' | 'control' = 'container') => ({ el, r: new DOMRect(left, 0, width, 24), kind })
const world = () => {
  const el = document.createElement('div')
  el.style.transform = 'translate(25px, 10px) scale(.75)'
  document.body.append(el)
  const peers = [20, 30, 40].map(width => { const child = document.createElement('div'); el.append(child); return placed(child, 100, width) })
  return { el, peers }
}
afterEach(() => document.body.replaceChildren())

describe('transformed coordinate realms', () => {
  it('reuses peer independence for boxes sharing the same rail and realm', () => {
    const one = world()
    const count = 200
    const boxes = Array.from({ length: count }, () => { const child = document.createElement('div'); one.el.append(child); return placed(child, 100, 40) })
    const original = Element.prototype.contains
    let calls = 0
    Element.prototype.contains = function (other) { calls++; return original.call(this, other) }
    try {
      expect(missesOf(boxes, { x: [100, 140] })).toEqual([])
      expect(calls).toBeLessThanOrEqual(count * count * 3)
    } finally {
      Element.prototype.contains = original
    }
  })

  it('does not align a page box to a rail owned only by a transformed world', () => {
    const one = world()
    const outside = document.createElement('div')
    document.body.append(outside)
    const boxes = [...one.peers, placed(outside, 102)]
    expect(missesOf(boxes, railsOf(boxes))).toEqual([])
  })

  it('does not align a transformed child to an unrelated page rail', () => {
    const one = world()
    const outside = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return placed(el, 200) })
    const child = document.createElement('div')
    one.el.append(child)
    const boxes = [...outside, placed(child, 202)]
    expect(missesOf(boxes, railsOf(boxes))).toEqual([])
  })

  it('keeps a physical one-pixel shift against peers in the same transformed world', () => {
    const one = world()
    const child = document.createElement('button')
    one.el.append(child)
    const shifted = placed(child, 101, 50, 'control')
    const boxes = [...one.peers, shifted]
    expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toEqual([child])
  })

  it('keeps a shared page rail and an outside one-pixel shift when an outside owner also owns it', () => {
    const one = world()
    const owner = document.createElement('div'), shifted = document.createElement('button')
    document.body.append(owner, shifted)
    const boxes = [...one.peers, placed(owner, 100), placed(shifted, 101, 50, 'control')]
    expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toEqual([shifted])
  })
})
