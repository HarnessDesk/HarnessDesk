import { afterEach, describe, expect, it, vi } from 'vitest'
import { missesOf, railsOf } from './guides'

const placed = (el: Element, left: number, width = 20, kind: 'container' | 'control' = 'container') => ({
  el, r: new DOMRect(left, 0, width, 24), kind,
})
const table = () => {
  const el = document.createElement('table')
  document.body.append(el)
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 120))
  const cells = Array.from({ length: 3 }, () => placed(el.insertRow().insertCell(), 100))
  return { el, cells }
}
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('semantic table column rails', () => {
  it('keeps a definition-list action from following an unrelated page interior rail', () => {
    const list = document.createElement('dl')
    document.body.append(list)
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 120))
    const pages = Array.from({ length: 3 }, () => { const el = document.createElement('div'); document.body.append(el); return placed(el, 100) })
    const action = document.createElement('button')
    list.append(action)
    const boxes = [...pages, placed(action, 101, 40, 'control')]
    expect(missesOf(boxes, railsOf(boxes))).toEqual([])
  })

  it('keeps a definition list’s internal value column local too', () => {
    const list = document.createElement('dl')
    document.body.append(list)
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 120))
    const values = Array.from({ length: 3 }, () => {
      const value = document.createElement('dd')
      list.append(value)
      return placed(value, 100)
    })
    const toolbar = document.createElement('button')
    document.body.append(toolbar)
    const boxes = [...values, placed(toolbar, 101, 40, 'control')]
    expect(missesOf(boxes, railsOf(boxes))).toEqual([])
  })

  it('keeps an internal column rail from judging an external toolbar button', () => {
    const one = table()
    const toolbar = document.createElement('button')
    document.body.append(toolbar)
    const boxes = [...one.cells, placed(toolbar, 101, 40, 'control')]
    expect(missesOf(boxes, railsOf(boxes))).toEqual([])
  })

  it('still reports a one-pixel shifted cell inside the table', () => {
    const one = table()
    const shifted = placed(one.el.insertRow().insertCell(), 101, 40)
    const boxes = [...one.cells, shifted]
    expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toEqual([shifted.el])
  })

  it('keeps the table’s outer edge available to external controls', () => {
    const one = table()
    const cells = one.cells.map(cell => ({ ...cell, r: new DOMRect(0, 0, 20, 24) }))
    const toolbar = document.createElement('button')
    document.body.append(toolbar)
    const boxes = [...cells, placed(toolbar, 1, 40, 'control')]
    expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toEqual([toolbar])
  })

  it('keeps a shared rail when an independent outside box also owns it', () => {
    const one = table()
    const outside = document.createElement('div')
    const toolbar = document.createElement('button')
    document.body.append(outside, toolbar)
    const boxes = [...one.cells, placed(outside, 100), placed(toolbar, 101, 40, 'control')]
    expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toEqual([toolbar])
  })
})
