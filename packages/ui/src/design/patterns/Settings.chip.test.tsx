import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  Chip,
  CodeText,
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

it('gives its dot a tone apart from the pill, on purpose', () => {
  const chip = draw(
    <Chip tone="neutral" dotTone="brand" dotPulse>
      Running
    </Chip>,
  )
  // The pill stays neutral; only the dot inside it disagrees.
  expect(chip.dataset['tone']).toBe('neutral')
  const dot = chip.querySelector('[data-slot="dot"]')
  if (!dot) throw new Error('no dot rendered')
  expect(dot.getAttribute('data-tone')).toBe('brand')
  expect(dot.hasAttribute('data-state')).toBe(false)
  expect(dot.hasAttribute('data-pulse')).toBe(true)
  expect(css).toMatch(/\.dot\[data-slot='dot'\]\[data-tone='brand'\]\s*\{[^}]*background:\s*var\(--hd-primary\)/s)
})

it('draws no dot at all without dotTone or a readiness state', () => {
  const chip = draw(<Chip tone="neutral">Idle</Chip>)
  expect(chip.querySelector('[data-slot="dot"]')).toBeNull()
})

it('lets a readiness state win over dotTone, since the two never both apply', () => {
  const chip = draw(<Chip state="ready" />)
  const dot = chip.querySelector('[data-slot="dot"]')
  expect(dot?.getAttribute('data-state')).toBe('ready')
  expect(dot?.hasAttribute('data-tone')).toBe(false)
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

it('stays on one line: bounded, ellipsised, never wrapping inside its pill', () => {
  const chip = draw(<Chip tone="neutral">verify ✓ @a1b2c3d — 2 commits since</Chip>)
  expect(css).toMatch(/\.chip\s*\{[^}]*max-width:\s*min\(100%, 240px\)[^}]*white-space:\s*nowrap/s)
  // Bare words sit in a span of their own, which is the box that ellipsises.
  const words = chip.querySelector('[data-slot="chip-words"]')
  expect(words?.children).toHaveLength(1)
  expect(words?.firstElementChild?.tagName).toBe('SPAN')
  expect(css).toMatch(/\.chipWords > span\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s)
})

it('says itself whole in title while it is cut, and keeps a title the caller gave', () => {
  const text = 'verify ✓ @a1b2c3d — 2 commits since'
  const chip = draw(<Chip tone="neutral">{text}</Chip>)
  const inner = chip.querySelector<HTMLElement>('[data-slot="chip-words"] > span')
  if (!inner) throw new Error('no words')
  Object.defineProperty(inner, 'scrollWidth', { configurable: true, value: 300 })
  Object.defineProperty(inner, 'clientWidth', { configurable: true, value: 120 })
  act(() => { chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(chip.getAttribute('title')).toBe(text)
  Object.defineProperty(inner, 'scrollWidth', { configurable: true, value: 100 })
  act(() => { chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(chip.hasAttribute('title')).toBe(false)

  const named = draw(<Chip tone="neutral" title="Whole story">Short</Chip>)
  act(() => { named.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(named.getAttribute('title')).toBe('Whole story')
})

it('marks stale with a history glyph, never a strikethrough, and mutes only a stale pass', () => {
  const pass = draw(<Chip tone="success" stale>verify ✓ @a1b2c3d</Chip>)
  expect(css).not.toMatch(/text-decoration:\s*line-through/)
  expect(css).toMatch(/\.chip\[data-stale\]:is\(\[data-tone='neutral'\], :not\(\[data-tone\]\)\)\s*\{[^}]*color:\s*var\(--hd-muted-foreground\)/s)
  const glyph = pass.firstElementChild
  expect(glyph?.tagName.toLowerCase()).toBe('svg')
  expect(glyph?.getAttribute('aria-hidden')).toBe('true')
  // A stale pass no longer vouches for what is there now.
  expect(pass.dataset['tone']).toBe('neutral')
  expect(pass.querySelector('.sr-only')?.textContent).toContain('stale')

  // A stale failure is still the last word: it keeps its danger ink.
  const failed = draw(<Chip tone="danger" stale>verify ✗ @a1b2c3d</Chip>)
  expect(failed.dataset['tone']).toBe('danger')
  expect(failed.className).toContain('bg-(--hd-danger-dim)')
  expect(failed.firstElementChild?.tagName.toLowerCase()).toBe('svg')
})

it('draws nothing for a zero count unless zero is the finding', () => {
  act(() => root.render(<Chip tone="neutral" count={0}>copies differ</Chip>))
  expect(container.innerHTML).toBe('')
  const shown = draw(<Chip tone="neutral" count={0} showZero>copies differ</Chip>)
  expect(shown.textContent).toBe('0 copies differ')
  const counted = draw(<Chip tone="warning" count={3}>copies differ</Chip>)
  expect(counted.textContent).toBe('3 copies differ')
  const bare = draw(<Chip tone="neutral" count={12} />)
  expect(bare.textContent).toBe('12')
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

