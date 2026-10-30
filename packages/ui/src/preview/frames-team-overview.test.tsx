import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { OverviewExample, overviewPreviewStore } from './frames-team-overview'
import { previewStore } from './harness'
import { OVERVIEW_STATES } from './team-overview-fixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const focused = vi.hoisted(() => ({ creates: 0 }))
vi.mock('./harness', async importOriginal => {
  const actual = await importOriginal<typeof import('./harness')>()
  return { ...actual, previewStore: (...args: Parameters<typeof actual.previewStore>) => {
    const [seed] = args
    if (seed && Object.keys(seed).sort().join(',') === 'accountsByRuntime,theme') focused.creates++
    return actual.previewStore(...args)
  } }
})

it('creates the focused preview store on demand and reuses the audited instance', () => {
  expect(focused.creates).toBe(0)
  const first = overviewPreviewStore()
  expect(overviewPreviewStore()).toBe(first)
  expect(first.getSnapshot().accountsByRuntime).toEqual({})
  expect(focused.creates).toBe(1)
})

it('renders Overview scenes repeatedly without adding store resize listeners and keeps the runtime label', () => {
  const add = vi.spyOn(window, 'addEventListener')
  // Do not leave the constructor's permanent listener installed in the test.
  add.mockImplementation((type, listener, options) => {
    if (type !== 'resize') return EventTarget.prototype.addEventListener.call(window, type, listener, options)
  })
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    const name = previewStore().getSnapshot().runtimes[0]!.presentation.name
    expect(name).toBe('Alpha')
    expect(add.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1)
    add.mockClear()
    for (let pass = 0; pass < 2; pass++) {
      for (const scene of OVERVIEW_STATES) {
        act(() => root.render(<OverviewExample scene={scene} />))
        if (scene === 'narrow') {
          const subtitles = [...host.querySelectorAll('[data-seat] [data-slot="list-row-subtitle"]')]
          expect(subtitles.some(element => element.textContent?.includes(`Reviewer · ${name}`))).toBe(true)
        }
      }
    }
    expect(add.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(0)
  } finally {
    act(() => root.unmount())
    host.remove()
    bounds.mockRestore()
    add.mockRestore()
  }
})
