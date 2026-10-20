import { afterEach, describe, expect, it } from 'vitest'
import { missesOf, railsOf } from './guides'

const placed = (el: Element, left = 100, width = 100, kind: 'container' | 'control' = 'container') => ({
  el, r: new DOMRect(left, 0, width, 24), kind,
})
const chain = () => {
  const wrappers = [document.createElement('div'), document.createElement('div'), document.createElement('button')]
  wrappers[0]!.append(wrappers[1]!)
  wrappers[1]!.append(wrappers[2]!)
  document.body.append(wrappers[0]!)
  return wrappers.map(el => placed(el))
}
afterEach(() => document.body.replaceChildren())

describe('independent guide rail ownership', () => {
  it('counts the nested wrappers of one control once', () => {
    expect(railsOf(chain()).x).toEqual([])
  })

  it('does not manufacture a third owner from two controls’ wrappers', () => {
    expect(railsOf([...chain(), ...chain()]).x).toEqual([])
  })

  it('keeps the shared edge of three independently placed siblings', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const rows = [100, 120, 140].map(width => {
      const el = document.createElement('div')
      parent.append(el)
      return placed(el, 100, width)
    })
    expect(railsOf([placed(parent, 100, 200), ...rows]).x).toEqual([100])
  })

  it.each(['container', 'control'] as const)('still finds a one-pixel shifted independent %s', kind => {
    const peers = [100, 120, 140].map(width => {
      const el = document.createElement('div')
      document.body.append(el)
      return placed(el, 100, width)
    })
    const el = document.createElement(kind === 'control' ? 'button' : 'div')
    document.body.append(el)
    const boxes = [...peers, placed(el, 101, 150, kind)]
    expect(missesOf(boxes, railsOf(boxes)).map(one => one.box.el)).toEqual([el])
  })
})
