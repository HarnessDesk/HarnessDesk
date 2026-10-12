import { ToolBodyControls } from './ToolBody'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import tokenSheet from '../foundation/tokens.css?raw'
import { GroupLine, PanelBody, PanelFrame, PanelFooter, PanelRow } from './InspectorPanel'

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
  expect(row.querySelector('[data-role="row"] [data-slot="middle-truncate"] .sr-only')?.textContent).toBe('Review')
})

it('cuts file titles and path subtitles in their middle while sentences wrap', () => {
  const path = 'packages/checkout/very-long-retry-budget-handler.ts'
  act(() => root.render(<><PanelRow title={path} sub={path} subPath /><PanelRow title="A refusal that must remain readable" wrapTitle /></>))
  expect([...container.querySelectorAll('[data-slot="middle-truncate"] .sr-only')].map(one => one.textContent)).toEqual([path, path])
  expect(container.querySelectorAll('[data-slot="inspector-row"]')[1]?.textContent).toBe('A refusal that must remain readable')
})

it('a reading inspector keeps its reading body and gives ordinary controls their row gutter', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<PanelFrame inset="reading"><ToolBodyControls>Title</ToolBodyControls><PanelBody>Words</PanelBody></PanelFrame>)
  expect(host.querySelector('[data-slot="tool-controls"]')!.className).toContain('px-(--hd-inset-row)')
  expect(host.querySelector('[data-slot="bar"]')).toBeNull()
  expect(host.querySelector('[data-slot="inspector-body"] [data-slot="pane-column"]')!.getAttribute('data-inset')).toBe('reading')
  expect(host.querySelector('[data-slot="inspector-body"]')!.className).not.toContain('p-2')
  expect(host.querySelector('[data-slot="inspector-body"]')!.className).toContain('gap-(--hd-card-gap)')
})

it('clamps prompts to two lines in secondary ink while allowing full refusal sentences', () => {
  act(() => root.render(<>
    <PanelRow title="Reviewer" ask="A long delegated prompt" />
    <PanelRow title="search" ask="A complete refusal sentence" askLines="all" />
  </>))
  const asks = [...container.querySelectorAll('[data-role="meta"]')]
  expect(asks[0]?.className).toContain('line-clamp-2')
  expect(asks[1]?.className).not.toContain('line-clamp')
  for (const ask of asks) {
    expect(ask.className).toContain('text-(--hd-secondary-foreground)')
    expect(ask.className).toContain('[overflow-wrap:anywhere]')
  }
})

it('B7 inspector footer is a quiet content footer outside a shell, never another bar', () => {
  const markup = renderToStaticMarkup(<PanelFooter left="12 recorded events" right="Read from this work" />)
  expect(markup).toContain('data-slot="content-footer"')
  expect(markup).not.toContain('data-slot="bar"')
  expect(markup).toContain('12 recorded events')
  expect(markup).toContain('Read from this work')
})
