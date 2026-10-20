import { afterEach, describe, expect, it, vi } from 'vitest'
import { missesOf, railsOf } from './guides'

const box = (el: Element, left: number, width = 20, kind: 'container' | 'control' = 'container') => {
  const r = new DOMRect(left, 0, width, 24)
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(r)
  return { el, r, kind }
}
const controls = (left = 100, column = false, ordinary = false) => {
  const el = document.createElement('div')
  el.style.display = 'flex'
  el.style.flexDirection = column ? 'column' : 'row'
  document.body.append(el)
  const children = [0, 1, 2, 3].map(index => {
    const child = document.createElement(ordinary && index === 0 ? 'span' : 'button')
    el.append(child)
    return box(child, left + (column ? 0 : index * 20), 20, ordinary && index === 0 ? 'container' : 'control')
  })
  return { group: box(el, left, column ? 20 : 80), children }
}
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('intrinsic control group ownership', () => {
  it('does not compare an inner control with an unrelated page rail', () => {
    const one = controls()
    const peers = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return box(el, 123, 50) })
    expect(missesOf([one.group, ...one.children, ...peers], railsOf([one.group, ...one.children, ...peers]))).toEqual([])
  })

  it('keeps ordinary flex content eligible for external alignment diagnostics', () => {
    const one = controls(100, false, true)
    const peers = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return box(el, 123, 50) })
    const boxes = [one.group, ...one.children, ...peers]
    expect(missesOf(boxes, railsOf(boxes)).some(one => one.box.el === boxes[2]!.el)).toBe(true)
  })

  it('keeps a one-pixel shift of the outer group visible', () => {
    const one = controls(101)
    const peers = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return box(el, 100, 50) })
    const boxes = [one.group, ...one.children, ...peers]
    expect(missesOf(boxes, railsOf(boxes)).some(miss => miss.box.el === one.group.el)).toBe(true)
  })

  it('keeps a one-pixel shifted control against three independent peers inside a group', () => {
    const one = controls(100, true)
    const shifted = { ...one.children[3]!, r: new DOMRect(101, 0, 20, 24) }
    const boxes = [one.group, ...one.children.slice(0, 3), shifted]
    expect(missesOf(boxes, railsOf(boxes)).filter(miss => miss.box.el === shifted.el)).toHaveLength(2)
  })
})
