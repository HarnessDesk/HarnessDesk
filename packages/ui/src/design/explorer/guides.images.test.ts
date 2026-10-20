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
