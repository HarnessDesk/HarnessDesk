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

/*
 * Both draw neutral: `asked` used to draw the warning tone, which read as a
 * warning on nearly every built-in Agent's chip, since most runtimes have no
 * control that holds a ceiling at all — amber as the ordinary state is amber
 * meaning nothing. The words "asked" and "held", not the chip's colour, carry
 * the difference (#898).
 */
it('says asked or held in words; both draw the same neutral tone', () => {
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
  expect(asked?.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
  expect(asked?.title).toMatch(/Asked, not held/)
  expect(held?.textContent).toBe('Read · held')
  expect(held?.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
  expect(held?.title).toBe('Changes nothing: it reads, searches and reports. Held: Read-only sandbox; anything past it asks you.')
})
