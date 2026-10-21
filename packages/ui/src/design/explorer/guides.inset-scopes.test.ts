import { afterEach, expect, it, vi } from 'vitest'
import { missesOf, railsOf } from './guides'

const box = (el: Element, left: number, width: number, kind: 'container' | 'control' = 'container') => {
  const r = new DOMRect(left, 0, width, 24)
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(r)
  return { el, r, kind }
}
const fixture = (declared = true, color = 'black') => {
  const frame = document.createElement('section')
  if (declared) { frame.style.padding = '2px'; frame.style.border = `1px solid ${color}` }
  document.body.append(frame)
  const outer = box(frame, 100, 200)
  const cards = [0, 1, 2].map(() => {
    const card = document.createElement('div')
    frame.append(card)
    return box(card, 103, 194)
  })
  const head = document.createElement('div')
  head.style.display = 'flex'
  const title = document.createElement('span')
  title.style.flexGrow = '1'
  const action = document.createElement('span')
  head.append(title, action)
  document.body.append(head)
  const header = box(head, 100, 200)
  const end = box(action, 260, 40)
  return { frame, outer, cards, header, end }
}
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

it.each(['black', 'transparent'])('keeps a chart’s declared content rails local with a %s border', color => {
  const { outer, cards, header, end } = fixture(true, color)
  const boxes = [outer, ...cards, header, end]
  expect(missesOf(boxes, railsOf(boxes))).toEqual([])
})
it.each(['left', 'right'] as const)('keeps a one-pixel shifted child visible against local %s content peers', side => {
  const { frame, outer, cards, header, end } = fixture()
  const child = document.createElement('div')
  frame.append(child)
  const shifted = box(child, side === 'left' ? 104 : 103, 193, 'control')
  const boxes = [outer, ...cards, header, end, shifted]
  expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toEqual([child])
})
it('retains the global rail when even one independent outside owner shares the frame content end', () => {
  const { outer, cards, header, end } = fixture()
  const peer = document.createElement('div')
  document.body.append(peer)
  const boxes = [outer, ...cards, header, end, box(peer, 197, 100)]
  expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toContain(header.el)
})
it('does not invent inset ownership for an undeclared three-pixel interior line', () => {
  const { outer, cards, header, end } = fixture(false)
  const boxes = [outer, ...cards, header, end]
  expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toContain(header.el)
})

it.each(['width', 'position'] as const)('still diagnoses an outer header %s shifted one pixel with its end action', change => {
  const { outer, cards, header, end } = fixture()
  const peers = [0, 1, 2].map(() => {
    const peer = document.createElement('div')
    document.body.append(peer)
    return box(peer, 100, 200)
  })
  header.r = new DOMRect(change === 'position' ? 101 : 100, 0, change === 'position' ? 200 : 201, 24)
  end.r = new DOMRect(261, 0, 40, 24)
  vi.mocked(header.el.getBoundingClientRect).mockReturnValue(header.r)
  vi.mocked(end.el.getBoundingClientRect).mockReturnValue(end.r)
  const boxes = [outer, ...cards, header, end, ...peers]
  expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toContain(header.el)
})
