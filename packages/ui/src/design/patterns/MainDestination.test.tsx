import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import css from './MainDestination.module.css?raw'
import { DestinationBody, MainDestination } from './MainDestination'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

it('keeps work and page input identity while only one main layer is interactive', () => {
  const render = (page: boolean) => act(() => root.render(<MainDestination page={page}
    work={<textarea aria-label="Draft" defaultValue="Remember this draft" />}
    pages={<DestinationBody active={page} id="library"><input aria-label="Query" defaultValue="remembered query" /></DestinationBody>} />))
  render(false)
  const draft = host.querySelector('textarea')!, query = host.querySelector('input')!
  draft.value = 'Edited draft'; query.value = 'Edited query'
  render(true)
  const work = host.querySelector<HTMLElement>('[data-slot="retained-work"]')!
  const pages = host.querySelector<HTMLElement>('[data-slot="destination-pages"]')!
  expect(work.hidden).toBe(false); expect(work.hasAttribute('data-hidden')).toBe(true); expect(work.hasAttribute('inert')).toBe(true)
  expect(pages.hidden).toBe(false); expect(pages.hasAttribute('inert')).toBe(false)
  expect(host.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Edited draft')
  render(false)
  expect(work.hidden).toBe(false); expect(work.hasAttribute('data-hidden')).toBe(false); expect(work.hasAttribute('inert')).toBe(false)
  expect(pages.hidden).toBe(true); expect(pages.hasAttribute('inert')).toBe(true)
  expect(host.querySelector('input')).toBe(query); expect(query.value).toBe('Edited query')
  const body = host.querySelector<HTMLElement>('[data-page-destination="library"]')!
  expect(body.hidden).toBe(true); expect(body.hasAttribute('inert')).toBe(true)
})

it('retained native work keeps its layout box while hidden outside the clipped destination', () => {
  expect(css).toMatch(/\.work\[data-hidden\]\s*\{[^}]*visibility:\s*hidden/)
  expect(css).toMatch(/\.work\[data-hidden\]\s*\{[^}]*pointer-events:\s*none/)
  expect(css).toMatch(/\.work\[data-hidden\]\s*\{[^}]*transform:\s*translateX\(-101%\)/)
})
