import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Chip } from './Settings'
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
