import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  Chip,
  CodeText,
  LibraryOperationList,
  LibraryOperationMark,
  LibraryReachFace,
  LibraryReachMark,
  MetaList,
  Monogram,
  Note,
  Text,
} from './Settings'
import css from './Settings.module.css?raw'

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

const draw = (node: ReactNode): HTMLElement => {
  act(() => root.render(node))
  const chip = container.firstElementChild
  if (!(chip instanceof HTMLElement)) throw new Error('no chip rendered')
  return chip
}

it('keeps the readiness form and its dot', () => {
  const chip = draw(<Chip state="ready" />)
  expect(chip.dataset['state']).toBe('ready')
  expect(chip.textContent).toBe('Ready')
  expect(chip.querySelector('[data-state="ready"]')).not.toBeNull()
})

it('takes a tone without a readiness state or an automatic dot', () => {
  const chip = draw(<Chip tone="info">Running</Chip>)
  expect(chip.hasAttribute('data-state')).toBe(false)
  expect(chip.dataset['tone']).toBe('info')
  expect(chip.className).toContain('bg-(--hd-tint-sky-fill)')
  expect(chip.textContent).toBe('Running')
  expect(chip.querySelector('[data-state]')).toBeNull()
})

it('takes an identity tint without turning it into a status claim', () => {
  const chip = draw(<Chip tint="violet">Session</Chip>)
  expect(chip.hasAttribute('data-state')).toBe(false)
  expect(chip.hasAttribute('data-tone')).toBe(false)
  expect(chip.dataset['tint']).toBe('violet')
  expect(chip.className).toContain('bg-(--hd-tint-violet-fill)')
  expect(chip.textContent).toBe('Session')
})

it('keeps a tinted icon and long identity inside one edged chip', () => {
  const chip = draw(
    <Chip tint="blue">
      <svg aria-hidden="true" />
      <span>feat/promo-stacking-for-the-seasonal-storefront</span>
    </Chip>,
  )
  expect(chip.querySelector('[data-slot="chip-words"]')?.children).toHaveLength(2)
  expect(css).toMatch(/\.chipWords\s*\{[^}]*display:\s*inline-flex[^}]*gap:\s*var\(--hd-space-1\)[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s)
  expect(css).toMatch(/\.chip\[data-tint][^}]*max-width:\s*190px/s)
  expect(css).toMatch(/\.chip\[data-tint='blue'\][^}]*box-shadow:\s*inset 0 0 0 1px var\(--hd-tint-blue-edge\)/s)
})

it('can emphasize the current fact without changing its semantic tone', () => {
  const chip = draw(<Chip tone="brand" emphasis>HEAD</Chip>)
  expect(chip.dataset['tone']).toBe('brand')
  expect(chip.dataset['emphasis']).toBe('')
})

it('says stale accessibly and refuses the success tone', () => {
  const chip = draw(<Chip tone="success" stale>Passed</Chip>)
  expect(chip.dataset['stale']).toBe('')
  expect(chip.textContent).toContain('stale')
  expect(chip.querySelector('.sr-only')?.textContent).toContain('stale')
  expect(chip.className).toContain('bg-(--hd-muted)')
  expect(chip.className).not.toContain('bg-(--hd-success-dim)')
})

it('defaults an unknown fact to Unknown and the neutral tone', () => {
  const chip = draw(<Chip tone="danger" unknown />)
  expect(chip.dataset['unknown']).toBe('')
  expect(chip.querySelector('[data-slot="chip-words"]')?.textContent).toBe('Unknown')
  expect(chip.querySelector('.sr-only')?.textContent).toContain('unknown')
  expect(chip.className).toContain('bg-(--hd-muted)')
  expect(chip.className).not.toContain('bg-(--hd-danger-dim)')
})

it('offers the compact tag size without inheriting the full chip height', () => {
  const chip = draw(<Chip tone="neutral" size="sm">Local</Chip>)
  expect(chip.dataset['size']).toBe('sm')
  expect(css).toMatch(/\.chip\[data-size='sm'\]\s*\{[^}]*height:\s*18px[^}]*padding:\s*0 var\(--hd-space-1-5\)[^}]*border-radius:\s*var\(--hd-radius-sm\)/s)
})

it('offers the established outline tag without changing the chip default', () => {
  const chip = draw(<Chip tone="neutral" size="sm" variant="outline" emphasis>Loaded first</Chip>)
  expect(chip.dataset['variant']).toBe('outline')
  expect(chip.dataset['emphasis']).toBe('')
  expect(css).toMatch(/\.chip\[data-variant='outline'\]\s*\{[^}]*border-radius:\s*var\(--hd-radius-full\)[^}]*background:\s*transparent/s)
  expect(css).toMatch(/\.chip\[data-variant='outline'\]\[data-emphasis\][^}]*color:\s*var\(--hd-secondary-foreground\)/s)
})

it('keeps a supporting note quiet while preserving its icon', () => {
  const note = draw(<Note icon={<svg data-testid="folder" />} ink="muted">Manifest required</Note>)
  expect(note.dataset['icon']).toBe('')
  expect(note.dataset['ink']).toBe('muted')
  expect(note.querySelector('[data-testid="folder"]')).not.toBeNull()
  expect(note.textContent).toBe('Manifest required')
})

it('lets verbatim values inherit the text role around them', () => {
  const code = draw(<CodeText as="code" size="inherit">~/skills/review</CodeText>)
  expect(code.dataset['size']).toBe('inherit')
  expect(code.textContent).toBe('~/skills/review')
})

it('keeps a text role while selecting its established ink tier', () => {
  const text = draw(<Text role="meta" ink="secondary">Operation detail</Text>)
  expect(text.dataset['role']).toBe('meta')
  expect(text.dataset['ink']).toBe('secondary')
  expect(text.className).toContain('text-(--hd-secondary-foreground)')
})

it('draws row marks and compact facts as named roles', () => {
  act(() => root.render(
    <>
      <Monogram>CR</Monogram>
      <MetaList><span>3 copies</span><span>Last Tuesday</span></MetaList>
    </>,
  ))
  expect(container.querySelector('[data-slot="monogram"]')?.textContent).toBe('CR')
  const list = container.querySelector('[data-slot="meta-list"]')
  expect(list?.children).toHaveLength(2)
  expect(list?.textContent).toBe('3 copiesLast Tuesday')
})

it('keeps every library reach state named by shape', () => {
  act(() => root.render(
    <>
      <LibraryReachMark state="reaches" label="Loaded" placement="cell" />
      <LibraryReachMark state="off" label="Switched off" />
      <LibraryReachMark state="unscanned" label="Outside scan paths" />
      <LibraryReachMark state="hollow" label="Empty on disk" />
    </>,
  ))
  const marks = [...container.querySelectorAll<HTMLElement>('[data-slot="library-reach-mark"]')]
  expect(marks.map((mark) => mark.dataset['state'])).toEqual(['reaches', 'off', 'unscanned', 'hollow'])
  expect(marks[0]?.dataset['placement']).toBe('cell')
  expect(marks[0]?.className).toContain('h-(--hd-control-h)')
  expect(marks.every((mark) => mark.getAttribute('role') === 'img')).toBe(true)
})

it('keeps agent identity content while reach controls only its plate', () => {
  const face = draw(<LibraryReachFace state="hollow" label="Agent A: empty on disk">A</LibraryReachFace>)
  expect(face.dataset['slot']).toBe('skill-reach')
  expect(face.dataset['state']).toBe('hollow')
  expect(face.dataset['problem']).toBe('')
  expect(face.getAttribute('aria-label')).toBe('Agent A: empty on disk')
  expect(face.textContent).toBe('A')
})

it('names operation marks and keeps a one-operation preview composed', () => {
  act(() => root.render(
    <LibraryOperationList>
      <div role="listitem"><LibraryOperationMark state="planned" />Create skill</div>
      <div role="listitem"><LibraryOperationMark state="done" />Done</div>
    </LibraryOperationList>,
  ))
  const list = container.querySelector<HTMLElement>('[data-slot="library-operation-list"]')
  expect(list?.getAttribute('role')).toBe('list')
  expect(list?.className).toContain('min-h-18')
  expect([...container.querySelectorAll<HTMLElement>('[data-slot="library-operation-mark"]')].map((mark) => mark.dataset['state'])).toEqual(['planned', 'done'])
})
