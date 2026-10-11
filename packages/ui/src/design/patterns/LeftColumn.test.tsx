import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LeftColumnGroup, LeftColumnRow, LeftColumnSeat, LeftColumnTop } from './LeftColumn'
import { FolderIcon } from '../../components/Icons'
import sheet from './LeftColumn.module.css?raw'
import styles from './LeftColumn.module.css'
import { DisclosureChevron } from '../ui/disclosure-chevron'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const mount = (node: ReactNode) => act(() => root.render(node))
const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!

test('a missing icon reserves its column; the only trailing action does not open its row', () => {
  const open = vi.fn(), more = vi.fn()
  mount(<LeftColumnGroup label="Projects">
    <LeftColumnRow label="Release notes · 長い会話名" onClick={open}
      trailing={{ kind: 'count', value: 3, label: '3 held messages' }}
      action={{ label: 'Actions for Release notes', onClick: more }} />
    <LeftColumnRow label="Another conversation" icon={<FolderIcon size={16} />} onClick={open} />
  </LeftColumnGroup>)
  expect(container.querySelectorAll('[data-slot="sidebar-menu-icon"]')).toHaveLength(2)
  expect(container.querySelectorAll('[data-left-trailing]')).toHaveLength(2)
  act(() => button('Actions for Release notes').click())
  expect(more).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
  expect(container.querySelector('button button')).toBeNull()
  act(() => button('Another conversation').click())
  expect(open).toHaveBeenCalledOnce()
})

test('the column top and seat bars meet without a separator hairline', () => {
  mount(<>
    <LeftColumnTop shown settings={false} back={false} forward={false} toggle={() => {}} goBack={() => {}}
      goForward={() => {}} search={<button aria-label="Search everything" />} />
    <LeftColumnSeat menu={<button>Seat</button>} settingsOpen={false} onSettings={() => {}} />
  </>)
  const bars = [...container.querySelectorAll<HTMLElement>('[data-slot="bar"]')]
  expect(bars).toHaveLength(2)
  expect(bars.map(bar => bar.getAttribute('data-rule'))).toEqual([null, null])
})

test('Settings keeps only the sidebar toggle in the column top row', () => {
  mount(<LeftColumnTop shown settings back goBack={() => {}} forward goForward={() => {}}
    toggle={() => {}} search={<button aria-label="Search everything" />} />)
  expect([...container.querySelectorAll('button')].map(one => one.getAttribute('aria-label'))).toEqual(['Hide sidebar'])
})

test('a row menu is beside its opener and remains the only trailing control', () => {
  mount(<LeftColumnRow label="New session" menu={{ label: 'More ways to start', content: () => <div>Start choices</div> }} />)
  expect(container.querySelectorAll('[data-left-trailing] button')).toHaveLength(1)
  expect(container.querySelector('button button')).toBeNull()
})

test('a foldable heading puts the disclosure directly after its name, outside the trailing action', () => {
  mount(<LeftColumnRow project label="Storefront" icon={<DisclosureChevron open size="xs" />} expanded action={{ kind: 'new', label: 'New session', onClick: vi.fn() }} />)
  const name = button('Storefront').querySelector('[data-left-fold-name]') ?? button('Storefront').querySelector('[data-slot="sidebar-menu-label-content"]')!
  const arrow = button('Storefront').querySelector('[data-slot="disclosure-chevron"]')!
  expect(arrow).not.toBeNull()
  expect(name.nextElementSibling).toBe(arrow)
  expect(button('Storefront').querySelector('[data-slot="sidebar-menu-icon"]')).toBeNull()
  expect(arrow.closest('[data-left-trailing]')).toBeNull()
  expect(arrow.getAttribute('data-size')).toBe('xs')
  expect(arrow.getAttribute('data-tone')).toBe('neutral')
  expect(arrow.hasAttribute('data-open')).toBe(true)
})

test('open disclosures hide at rest and reveal on heading hover or keyboard focus; folded disclosures remain visible', () => {
  // jsdom has no pointer or keyboard modality. Exercise the real visibility
  // cascade with those pseudo states represented by test attributes; the
  // browser contract below exercises actual hover and focus-visible.
  const visibility = [...sheet.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .filter(([, , body]) => body!.includes('visibility:'))
    .map(([, selector, body]) => `${selector}{${body}}`).join('\n')
    .replace(/\.([\w-]+)/g, (match, name: string) => styles[name] ? `.${styles[name]}` : match)
    .replaceAll(':hover', '[data-test-hover]')
    .replaceAll(':focus-visible', '[data-test-focus-visible]')
    .replaceAll(':focus-within', '[data-test-focus-within]')
  const css = document.createElement('style')
  css.textContent = visibility
  document.head.append(css)
  try {
    mount(<LeftColumnRow project label="Storefront" icon={<DisclosureChevron open size="xs" />} expanded
      action={{ kind: 'new', label: 'New session', onClick: vi.fn() }} />)
    const heading = button('Storefront'), row = heading.parentElement!
    const arrow = heading.querySelector('[data-slot="disclosure-chevron"]')!
    expect(arrow).not.toBeNull()
    expect(getComputedStyle(arrow).visibility).toBe('hidden')
    row.setAttribute('data-test-focus-within', '')
    expect(getComputedStyle(button('New session')).visibility).toBe('hidden')
    row.setAttribute('data-test-hover', '')
    expect(getComputedStyle(arrow).visibility).toBe('visible')
    expect(getComputedStyle(button('New session')).visibility).toBe('visible')
    row.removeAttribute('data-test-hover')
    act(() => heading.focus())
    heading.setAttribute('data-test-focus-visible', '')
    expect(getComputedStyle(arrow).visibility).toBe('visible')
    expect(getComputedStyle(button('New session')).visibility).toBe('visible')
    heading.removeAttribute('data-test-focus-visible')
    expect(getComputedStyle(arrow).visibility).toBe('hidden')
    expect(getComputedStyle(button('New session')).visibility).toBe('hidden')
    mount(<LeftColumnRow project label="Storefront" expanded={false} />)
    expect(getComputedStyle(arrow).visibility).toBe('visible')
    expect(arrow.hasAttribute('data-open')).toBe(false)
  } finally { css.remove() }
})
