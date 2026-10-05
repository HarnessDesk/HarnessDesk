import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import tokenSheet from '../foundation/tokens.css?raw'
import { GroupLine, PanelBody, PanelFrame, PanelPill, PanelRow, PanelTools } from './InspectorPanel'

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

it('keeps a sticky group line on the panel ground, and an ordinary one in the flow', () => {
  act(() => root.render(
    <>
      <GroupLine left="Turn 1" right="1.2s" sticky />
      <GroupLine left="This turn · 2 files" />
    </>,
  ))
  const [sticky, plain] = [...container.querySelectorAll<HTMLElement>('[data-slot="inspector-group"]')]
  expect(sticky?.hasAttribute('data-sticky')).toBe(true)
  expect(sticky?.className).toContain('sticky top-0')
  expect(sticky?.className).toContain('bg-(--hd-background)')
  expect(plain?.hasAttribute('data-sticky')).toBe(false)
  expect(plain?.className).not.toContain('sticky')
})

it('says who produced a row before its mark, at the meta step and in the words given', () => {
  act(() => root.render(<PanelRow lead="Shell" mark={<span data-testid="mark" />} title="git status" />))
  const row = container.querySelector<HTMLElement>('[data-slot="inspector-row"]')
  const lead = row?.firstElementChild as HTMLElement | null
  expect(lead?.textContent).toBe('Shell')
  expect(lead?.dataset['role']).toBe('meta')
  expect(lead?.nextElementSibling?.getAttribute('data-slot')).toBe('inspector-row-mark')
  expect(lead?.className).not.toContain('uppercase')
})

describe('the filter pill', () => {
  it('steps its own fill toward the ink under the pointer, and keeps the accent while pressed', () => {
    const rest = renderToStaticMarkup(<PanelPill>Staged</PanelPill>)
    expect(rest).toContain('hover:bg-(--hd-chip-fill-hover)')
    expect(rest).toContain('aria-pressed="false"')
    const pressed = renderToStaticMarkup(<PanelPill pressed>Staged</PanelPill>)
    expect(pressed).toContain('aria-pressed="true"')
    expect(pressed).toContain('hover:bg-(--hd-accent-dim)')
    expect(pressed).not.toContain('hover:bg-(--hd-chip-fill-hover)')
  })

  it('takes a longer hover step in the dark theme, where a short one reads as none', () => {
    const step = (block: string): number => Number(/--hd-chip-fill-hover:\s*color-mix\(in srgb, var\(--hd-chip-fill\) (\d+)%/.exec(block)?.[1])
    const dark = tokenSheet.slice(tokenSheet.indexOf('body[data-hd-dark-theme] {'))
    expect(step(tokenSheet)).toBeGreaterThan(step(dark))
    expect(step(dark)).toBeLessThanOrEqual(88)
  })
})

it.each([
  { sub: 'A path' },
  { tall: true, sub: 'A path' },
  { ask: 'A question that needs an answer' },
  { meta: 'Running · 12s' },
])('centres the compact row, its face and trailing time through $sub $ask $meta', (extra) => {
  act(() => root.render(<PanelRow title="Review" mark={<span />} trail={<span>12s</span>} {...extra} />))
  const row = container.querySelector<HTMLElement>('[data-slot="inspector-row"]')!
  expect(row.dataset['hdTable']).toBe('compact')
  expect(row.className).toContain('items-center')
  expect(row.className).not.toContain('items-start')
  expect(row.className).toContain('px-(--hd-table-edge)')
  const mark = row.querySelector<HTMLElement>('[data-slot="inspector-row-mark"]')!
  expect(mark.className).toContain('size-(--hd-table-face)')
  expect(mark.className).not.toContain('mt-px')
  expect(row.querySelector('[data-role="row"]')?.textContent).toBe('Review')
})

it('a reading inspector gives its tools and body one reading gutter', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<PanelFrame inset="reading"><PanelTools>Title</PanelTools><PanelBody>Words</PanelBody></PanelFrame>)
  expect(host.querySelector('[data-slot="inspector-tools"]')!.className).toContain('px-(--hd-space-6)')
  expect(host.querySelector('[data-slot="inspector-body"] [data-slot="pane-column"]')!.getAttribute('data-inset')).toBe('reading')
  expect(host.querySelector('[data-slot="inspector-body"]')!.className).not.toContain('p-2')
})
