import { afterEach, expect, it, vi } from 'vitest'
import { collect, missesOf, railsOf, spillsOf } from './guides'

const bounds = new DOMRect(0, 0, 400, 200)
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

it('collects a semantic image as one glyph while ordinary labels and shifted boxes retain their rails', () => {
  const root = document.createElement('div'), image = document.createElement('span'), number = document.createElement('span')
  image.setAttribute('role', 'img'); image.setAttribute('aria-label', '3 other projects')
  number.dataset['slot'] = 'text'; number.textContent = '3'; image.append(number); root.append(image); document.body.append(root)
  for (const el of [document.body, root]) vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(bounds)
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(216, 0, 24, 24))
  vi.spyOn(number, 'getBoundingClientRect').mockReturnValue(new DOMRect(224, 4, 8, 16))
  expect(collect(root, bounds).map(one => [one.el, one.kind])).toEqual([[image, 'glyph']])
  image.removeAttribute('role')
  expect(collect(root, bounds).map(one => [one.el, one.kind])).toEqual([[number, 'text']])
  const peers = Array.from({ length: 3 }, () => { const el = document.createElement('div'); root.append(el); return { el, r: new DOMRect(223, 0, 20, 24), kind: 'container' as const } })
  const text = collect(root, bounds)
  expect(missesOf([...peers, ...text], railsOf([...peers, ...text])).map(one => one.box.el)).toContain(number)
})

it('leaves a box that crops its picture on purpose out of the overflow findings', () => {
  const root = document.createElement('div'), plate = document.createElement('span')
  plate.dataset['slot'] = 'face-picture-plate'
  plate.style.overflowX = 'hidden'
  plate.style.overflowY = 'hidden'
  plate.append(document.createElement('img'))
  root.append(plate); document.body.append(root)
  for (const el of [document.body, root]) vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(bounds)
  vi.spyOn(plate, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 20, 20))
  for (const [name, value] of [['clientWidth', 20], ['scrollWidth', 25], ['clientHeight', 20], ['scrollHeight', 25]] as const) {
    Object.defineProperty(plate, name, { configurable: true, value })
  }
  // Without the marker a box whose content is larger than it is a clip.
  expect(spillsOf(collect(root, bounds), bounds, root).map(one => one.how)).toEqual(['clipped'])
  // A crop says so, because the picture being larger than the plate is the drawing.
  plate.setAttribute('data-crop', '')
  expect(spillsOf(collect(root, bounds), bounds, root)).toEqual([])
  // The marker is about the plate's own content, not about where it sits: a
  // crop that has been pushed off the page is still content off the page.
  vi.spyOn(plate, 'getBoundingClientRect').mockReturnValue(new DOMRect(390, 10, 20, 20))
  expect(spillsOf(collect(root, bounds), bounds, root).map(one => one.how)).toEqual(['leaves page'])
})

it('still diagnoses actual painted content spilling outside a semantic image', () => {
  const root = document.createElement('div'), image = document.createElement('span'), paint = document.createElement('span')
  image.setAttribute('role', 'img'); paint.style.background = 'red'; image.append(paint); root.append(image); document.body.append(root)
  for (const el of [document.body, root]) vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(bounds)
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 24, 24))
  Object.defineProperty(image, 'clientWidth', { value: 24 })
  Object.defineProperty(image, 'scrollWidth', { value: 30 })
  vi.spyOn(paint, 'getBoundingClientRect').mockReturnValue(new DOMRect(30, 10, 10, 24))
  expect(spillsOf(collect(root, bounds), bounds, root).map(one => [one.el, one.how])).toContainEqual([image, 'spills'])
})
