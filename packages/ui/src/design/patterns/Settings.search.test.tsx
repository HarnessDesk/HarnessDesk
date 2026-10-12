import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { Search } from './Settings'

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

it('offers an accessible clear action only while the field has a value', () => {
  const onClear = vi.fn()
  const render = (value: string) => act(() => root.render(
    <Search
      value={value}
      onChange={() => {}}
      placeholder="Search history"
      clear={{ label: 'Clear the search', onClick: onClear }}
    />,
  ))

  render('')
  expect(container.querySelector('button')).toBeNull()
  render('needle')
  const clear = container.querySelector<HTMLButtonElement>('button[aria-label="Clear the search"]')
  expect(clear).not.toBeNull()
  act(() => clear?.click())
  expect(onClear).toHaveBeenCalledOnce()
})

it('mounts as a compact quiet filter without swallowing input events', () => {
  const onFocus = vi.fn()
  const onKeyDown = vi.fn()
  act(() => root.render(
    <Search
      value=""
      onChange={() => {}}
      placeholder="Filter sessions"
      size="compact"
      icon="filter"
      title="Narrow the list below."
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    />,
  ))

  const search = container.querySelector<HTMLElement>('[data-slot="search"]')
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')
  expect(search?.dataset['size']).toBe('compact')
  expect(search?.dataset['icon']).toBe('filter')
  expect(search?.querySelector('svg')?.classList.contains('lucide-funnel')).toBe(true)
  expect(input?.dataset['variant']).toBe('quiet')
  expect(input?.dataset['size']).toBe('compact')
  expect(input?.title).toBe('Narrow the list below.')
  act(() => {
    input?.focus()
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(onFocus).toHaveBeenCalledOnce()
  expect(onKeyDown).toHaveBeenCalledOnce()
})

it('mounts a bare search field with no icon or boxed input chrome', () => {
  act(() => root.render(
    <Search
      value=""
      onChange={() => {}}
      placeholder="Search palette"
      size="bare"
      icon="none"
      focusIndicator="caret"
    />,
  ))

  const search = container.querySelector<HTMLElement>('[data-slot="search"]')
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')
  expect(search?.dataset['size']).toBe('bare')
  expect(search?.dataset['icon']).toBe('none')
  expect(search?.querySelector('svg')).toBeNull()
  expect(input?.dataset['variant']).toBe('bare')
  expect(input?.dataset['size']).toBe('bare')
  expect(input?.getAttribute('data-focus-indicator')).toBe('caret')
})

it('hands its input to an owning surface for initial focus', () => {
  const inputRef = { current: null as HTMLInputElement | null }
  act(() => root.render(
    <Search
      value=""
      onChange={() => {}}
      placeholder="Search actions"
      inputRef={inputRef}
    />,
  ))

  expect(inputRef.current).toBe(container.querySelector('input[type="search"]'))
})

it('lets an always-focused field use its caret as the focus cue without changing other searches', () => {
  act(() => root.render(<>
    <Search value="" onChange={() => {}} placeholder="Palette search" focusIndicator="caret" />
    <Search value="" onChange={() => {}} placeholder="Ordinary search" />
  </>))
  expect(container.querySelector('[aria-label="Palette search"]')?.getAttribute('data-focus-indicator')).toBe('caret')
  expect(container.querySelector('[aria-label="Ordinary search"]')?.hasAttribute('data-focus-indicator')).toBe(false)
})

it('clears nonempty Search on Escape without letting its page leave, and leaves empty/composing Escape alone', () => {
  const change=vi.fn(), keys=vi.fn()
  const draw=(value:string)=>act(()=>root.render(<Search value={value} onChange={change} onKeyDown={keys} placeholder="Search settings" />))
  draw('runtime')
  const input=container.querySelector('input')!
  const escape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})
  act(()=>input.dispatchEvent(escape))
  expect(change).toHaveBeenCalledWith('')
  expect(escape.defaultPrevented).toBe(true)
  expect(keys).toHaveBeenCalledOnce()
  change.mockClear();draw('')
  const empty=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})
  act(()=>input.dispatchEvent(empty))
  expect(empty.defaultPrevented).toBe(false);expect(change).not.toHaveBeenCalled()
  draw('runtime')
  const composing=new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true})
  act(()=>input.dispatchEvent(composing))
  expect(composing.defaultPrevented).toBe(false);expect(change).not.toHaveBeenCalled()
})

it.each(['popover', 'menu'])('lets Escape close a %s while preserving its nonempty filter', kind => {
  const change = vi.fn(), parentKeys = vi.fn()
  act(() => root.render(<div {...(kind === 'menu' ? { role: 'menu' } : { 'data-popup-kind': 'menu' })} onKeyDown={parentKeys}>
    <Search value="Run 2" onChange={change} placeholder="Filter Runs" />
  </div>))
  const input = container.querySelector('input')!
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => input.dispatchEvent(escape))
  expect(change).not.toHaveBeenCalled()
  expect(input.value).toBe('Run 2')
  expect(escape.defaultPrevented).toBe(false)
  expect(parentKeys).toHaveBeenCalledOnce()
  const composing = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
  act(() => input.dispatchEvent(composing))
  expect(change).not.toHaveBeenCalled()
  expect(composing.defaultPrevented).toBe(false)
})
