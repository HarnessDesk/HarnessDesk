import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Face } from './Kit'

/**
 * A person's face. Pinned: a face this build ships draws its picture;
 * anything else the profile may hold — a later build's face, a picture it
 * keeps, garbage — draws the house mark rather than a broken image; the tile
 * is squared and sized by its prop, or fills the box it is put in.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (node: ReactNode): HTMLElement => {
  act(() => root.render(node))
  const tile = container.firstElementChild
  if (!(tile instanceof HTMLElement)) throw new Error('no tile')
  return tile
}

it('draws the picture for a face this build ships, and the mark for anything else', () => {
  expect(render(<Face avatar="wizard" size={24} />).querySelector('img')?.getAttribute('src')).toMatch(/\/wizard\.png$/)
  for (const stored of [undefined, null, 'pirate', 'black', { kind: 'image', src: 'a.png' }]) {
    const tile = render(<Face avatar={stored} size={24} />)
    expect(tile.querySelector('img')).toBeNull()
    expect(tile.querySelector('.brand-harnessdesk')).not.toBeNull()
  }
})

it('is squared and sized by its prop, or fills the box it is put in', () => {
  const sized = render(<Face avatar={null} size={44} />)
  expect(sized.dataset['shape']).toBe('square')
  expect(sized.dataset['size']).toBe('m')
  expect(sized.style.width).toBe('44px')
  const filling = render(<Face avatar={null} />)
  expect(filling.hasAttribute('data-fill')).toBe(true)
  expect(filling.style.width).toBe('')
})
