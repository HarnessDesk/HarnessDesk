import { afterEach, describe, expect, it, vi } from 'vitest'
import { missesOf, railsOf } from './guides'

const box = (el: Element, left: number, width = 20, kind: 'container' | 'control' | 'text' = 'container') => ({ el, r: new DOMRect(left, 0, width, 24), kind })
const endGroup = (right: number, width: number) => {
  const row = document.createElement('div')
  row.style.display = 'flex'
  const label = document.createElement('span')
  label.style.flexGrow = '1'
  const group = document.createElement('span')
  row.append(label, group)
  document.body.append(row)
  return box(group, right - width, width)
}
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('CSS anchored guide ownership', () => {
  it('keeps an end anchor on its declared parent content edge, but diagnoses a one-pixel shift', () => {
    const group = endGroup(188, 40)
    const parent = group.el.parentElement!
    ;(parent as HTMLElement).style.paddingRight = '12px'
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 24))
    const owner = box(parent, 0, 200)
    const peers = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return box(el, 189, 40) })
    expect(missesOf([...peers, owner, group], railsOf([...peers, owner, group]))).toEqual([])
    const shifted = { ...group, r: new DOMRect(147, 0, 40, 24) }
    expect(missesOf([...peers, owner, shifted], railsOf([...peers, owner, shifted])).map(one => one.box.el)).toEqual([group.el])
  })

  it('keeps a parent and its exact-content-end child shifted together visible against independent page peers', () => {
    const group = endGroup(189, 40)
    const parent = group.el.parentElement!
    ;(parent as HTMLElement).style.paddingRight = '12px'
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(new DOMRect(1, 0, 200, 24))
    const owner = box(parent, 1, 200)
    const peers = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return box(el, 0, 188) })
    expect(missesOf([...peers, owner, group], railsOf([...peers, owner, group])).map(one => one.box.el)).toContain(parent)
    // An uncollected parent cannot lend its otherwise-unmeasured authority.
    expect(missesOf([...peers, group], railsOf([...peers, group])).map(one => one.box.el)).toEqual([group.el])
  })

  it('measures the borrowed parent’s right edge when only its width and the child’s end move one pixel', () => {
    const groups = [0, 1, 2, 3].flatMap(index => {
      const group = endGroup(index === 3 ? 189 : 188, 40)
      const parent = group.el.parentElement!
      ;(parent as HTMLElement).style.paddingRight = '12px'
      const owner = box(parent, 0, index === 3 ? 201 : 200)
      vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(owner.r)
      return [owner, group]
    })
    expect(missesOf(groups, railsOf(groups)).map(one => one.box.el)).toEqual([groups[6]!.el])
  })

  it('does not compare a short inner label’s start with its end anchor’s outside edge', () => {
    const group = endGroup(200, 80)
    const child = document.createElement('span')
    group.el.append(child)
    const peers = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return box(el, 200) })
    const boxes = [group, ...peers, box(child, 197, 3, 'text')]
    expect(missesOf(boxes, railsOf(boxes))).toEqual([])
  })
  it('does not let a display-none growing sibling hide a real one-pixel shift', () => {
    const group = endGroup(131, 30)
    ;(group.el.previousElementSibling as HTMLElement).style.display = 'none'
    const peers = [20, 30, 40].map(width => { const el = document.createElement('div'); document.body.append(el); return box(el, 100, width) })
    const boxes = [...peers, group]
    expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toEqual([group.el])
    ;(group.el.previousElementSibling as HTMLElement).style.display = 'block'
    expect(missesOf(boxes, railsOf(boxes))).toEqual([])
    ;(group.el.previousElementSibling as HTMLElement).style.visibility = 'hidden'
    expect(missesOf(boxes, railsOf(boxes))).toEqual([])
  })

  it('does not reinterpret a fixed last-item margin as an end anchor', () => {
    const group = endGroup(141, 40)
    ;(group.el.previousElementSibling as HTMLElement).style.flexGrow = '0'
    ;(group.el as HTMLElement).style.marginLeft = '12px'
    const peers = [20, 30, 40].map(width => { const el = document.createElement('div'); document.body.append(el); return box(el, 100, width) })
    expect(missesOf([...peers, group], railsOf([...peers, group])).map(one => one.box.el)).toEqual([group.el])
  })

  it('recognizes an actual auto start margin and still diagnoses a shifted end', () => {
    const groups = [40, 45, 50, 55].map((width, index) => {
      const group = endGroup(index === 3 ? 201 : 200, width)
      ;(group.el.previousElementSibling as HTMLElement).style.flexGrow = '0'
      ;(group.el as HTMLElement).style.marginInlineStart = 'auto'
      return group
    })
    expect(missesOf(groups, railsOf(groups)).map(one => one.box.el)).toEqual([groups[3]!.el])
  })

  it('judges intrinsic end groups by their shared right edge, not varying text starts', () => {
    const groups = [40, 40, 40, 42].map(width => endGroup(200, width))
    expect(missesOf(groups, railsOf(groups))).toEqual([])
  })

  it('still diagnoses a one-pixel shift of an end group’s right anchor', () => {
    const groups = [40, 45, 50].map(width => endGroup(200, width))
    const shifted = endGroup(201, 55)
    expect(missesOf([...groups, shifted], railsOf([...groups, shifted])).map(one => one.box.el)).toEqual([shifted.el])
  })

  it('keeps three-peer inner rails and a one-pixel shifted child inside an end group', () => {
    const group = endGroup(200, 80)
    const children = [0, 1, 2, 3].map(index => {
      const child = document.createElement('button')
      group.el.append(child)
      return box(child, index === 3 ? 131 : 130, 20, 'control')
    })
    expect(missesOf([group, ...children], railsOf([group, ...children])).map(one => one.box.el)).toEqual([children[3]!.el, children[3]!.el])
  })
})

describe.each(['header', 'radiogroup', 'tablist', 'toolbar'])('semantic %s guide ownership', role => {
  const header = () => {
    const el = document.createElement(role === 'header' ? 'header' : 'div')
    if (role !== 'header') el.setAttribute('role', role)
    document.body.append(el)
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 48))
    return el
  }

  it('does not compare a header title to an unrelated page interior rail', () => {
    const band = header()
    const title = document.createElement(role === 'header' ? 'h1' : 'button')
    band.append(title)
    const pages = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return box(el, 100) })
    const boxes = [...pages, box(title, 102, 40, role === 'header' ? 'text' : 'control')]
    expect(missesOf(boxes, railsOf(boxes))).toEqual([])
  })

  it.each(['first', 'last'] as const)('keeps a %s control on the declared group inset, but diagnoses a one-pixel shift', edge => {
    const band = header()
    band.style.padding = '1px'
    const child = document.createElement('button')
    band.append(child)
    const peers = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return box(el, edge === 'first' ? 0 : 100, edge === 'first' ? 100 : 300) })
    const control = box(child, edge === 'first' ? 1 : 359, 40, 'control')
    expect(missesOf([...peers, control], railsOf([...peers, control]))).toEqual([])
    const shifted = { ...control, r: new DOMRect(edge === 'first' ? 2 : 358, 0, 40, 24) }
    expect(missesOf([...peers, shifted], railsOf([...peers, shifted])).map(one => one.box.el)).toEqual([child])
  })

  it('preserves a one-pixel shift against three independent inner header peers', () => {
    const band = header()
    const children = [0, 1, 2, 3].map(index => { const el = document.createElement(role === 'header' ? 'h2' : 'button'); band.append(el); return box(el, index === 3 ? 101 : 100, 40, role === 'header' ? 'text' : 'control') })
    expect(missesOf(children, railsOf(children)).map(one => one.box.el)).toEqual(role === 'header' ? [children[3]!.el] : [children[3]!.el, children[3]!.el])
  })

  it('keeps the header’s outside edge available across scopes', () => {
    const band = header()
    const peers = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return box(el, 0) })
    const shifted = box(band, 1, 400)
    expect(missesOf([...peers, shifted], railsOf([...peers, shifted])).map(one => one.box.el)).toEqual([band])
  })
})
