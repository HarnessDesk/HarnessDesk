import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from './context'
import { AppStore } from './store'
import { useTheme } from './theme'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.removeAttribute('data-hd-faces-pending')
  document.body.removeAttribute('data-hd-faces')
})

it.each(['square', 'round', 'failure'] as const)('holds faces through a delayed %s preference and applies it before reveal', async (answer) => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  const store = new AppStore('ws://localhost:0/')
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const response = new Promise((yes, no) => { resolve = yes; reject = no })
  vi.spyOn(store.transport, 'request').mockReturnValue(response as never)
  const observed: Array<[boolean, string | null]> = []
  const Probe = () => {
    useTheme()
    useLayoutEffect(() => { observed.push([document.body.hasAttribute('data-hd-faces-pending'), document.body.getAttribute('data-hd-faces')]) })
    return <><span data-shape="face">face</span><span>other content</span></>
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  document.body.setAttribute('data-hd-faces-pending', '')
  await act(async () => { root.render(<StoreProvider store={store}><Probe /></StoreProvider>) })
  expect(observed.at(-1)).toEqual([true, null])
  let loading!: Promise<void>
  await act(async () => { loading = store.loadPreferences() })
  expect(observed.at(-1)).toEqual([true, null])
  await act(async () => {
    if (answer === 'failure') reject(new Error('unavailable'))
    else resolve({ faces: answer })
    await loading
    // The store batches subscriber notifications to the next frame.
    await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()))
  })
  expect(observed.at(-1)).toEqual([false, answer === 'square' ? 'square' : null])
  act(() => root.unmount())
  container.remove()
})

it('leaves preview defaults visible and hides only face surfaces while startup is pending', async () => {
  const { previewStore } = await import('../preview/harness')
  const css = (await import('../styles/shadcn-themes.css?raw')).default
  const rule = css.match(/body\[data-hd-faces-pending\][^{]+\{[^}]+\}/)?.[0]
  expect(rule).toBeTruthy()
  const style = document.createElement('style')
  style.textContent = rule!
  document.head.appendChild(style)
  const face = document.createElement('span')
  face.dataset.shape = 'face'
  const other = document.createElement('span')
  document.body.append(face, other)
  expect(previewStore().getSnapshot()).toMatchObject({ faces: 'round', preferencesLoaded: true })
  expect(getComputedStyle(face).visibility).not.toBe('hidden')
  document.body.setAttribute('data-hd-faces-pending', '')
  expect(getComputedStyle(face).visibility).toBe('hidden')
  expect(getComputedStyle(other).visibility).not.toBe('hidden')
  face.remove()
  other.remove()
  style.remove()
})

it('reveals faces during an initial connection failure and holds them again while recovered preferences load', async () => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  const store = new AppStore('ws://localhost:0/')
  const handlers = (store.transport as unknown as { handlers: { onStatus(status: 'connecting' | 'reconnecting' | 'open'): void } }).handlers
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const Probe = () => { useTheme(); return <span data-shape="face">face</span> }
  document.body.setAttribute('data-hd-faces-pending', '')
  await act(async () => { root.render(<StoreProvider store={store}><Probe /></StoreProvider>) })
  const change = async (status: 'connecting' | 'reconnecting' | 'open') => {
    await act(async () => { handlers.onStatus(status); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
  }
  await change('connecting')
  expect(document.body.hasAttribute('data-hd-faces-pending')).toBe(true)
  await change('reconnecting')
  expect(document.body.hasAttribute('data-hd-faces-pending')).toBe(false)
  await change('open')
  expect(document.body.hasAttribute('data-hd-faces-pending')).toBe(true)
  vi.spyOn(store.transport, 'request').mockResolvedValue({ faces: 'square' } as never)
  await act(async () => { await store.loadPreferences(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
  expect(document.body.hasAttribute('data-hd-faces-pending')).toBe(false)
  expect(document.body.getAttribute('data-hd-faces')).toBe('square')
  act(() => root.unmount())
  container.remove()
})
