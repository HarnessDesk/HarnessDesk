import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { CeilingChip } from './CeilingChip'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('draws asked in the warning tone and says asked; held is neutral and says held', () => {
  act(() => {
    root.render(
      <>
        <CeilingChip ceiling={{ level: 'read', hold: 'asked' }} />
        <CeilingChip ceiling={{ level: 'read', hold: 'held' }} note="Read-only sandbox; anything past it asks you" />
      </>,
    )
  })
  const [asked, held] = [...host.querySelectorAll('[data-ceiling]')] as HTMLElement[]
  expect(asked?.textContent).toBe('Read · asked')
  expect(asked?.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('warning')
  expect(asked?.title).toMatch(/Asked, not held/)
  expect(held?.textContent).toBe('Read · held')
  expect(held?.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
  expect(held?.title).toBe('Changes nothing: it reads, searches and reports. Held: Read-only sandbox; anything past it asks you.')
})
