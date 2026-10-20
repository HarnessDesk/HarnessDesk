import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { FlowBriefDialog } from './flow-brief-content'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('starts the pending import from the visible Brief outside technical Details', async () => {
  vi.useFakeTimers()
  // jsdom has no DataTransfer; keep the fixture's real change event and file
  // read, supplying only the browser's missing FileList construction boundary.
  vi.stubGlobal('DataTransfer', class {
    files: File[] = []
    items = { add: (file: File) => this.files.push(file) }
  })
  vi.spyOn(HTMLInputElement.prototype, 'files', 'set').mockImplementation(function (this: HTMLInputElement, files) {
    Object.defineProperty(this, 'files', { configurable: true, value: files })
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<FlowBriefDialog scene="pending" />))
    for (let tick = 0; tick < 20; tick++) await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]
    const reading = buttons.find(button => button.textContent === 'Reading…')
    expect(reading).toBeDefined()
    expect(reading?.disabled).toBe(true)
    expect(buttons.find(button => button.textContent === 'Start Team')?.disabled).toBe(true)
    const brief = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find(area => [...area.labels ?? []].some(label => label.textContent === 'Brief'))!
    expect(brief).not.toBeNull()
    expect(brief.closest('[hidden]')).toBeNull()
    expect(brief.closest('[data-flow-details]')).toBeNull()
    await act(async () => window.dispatchEvent(new Event('finish-dialog-brief-read')))
    expect(brief.value).toBe('Imported brief')
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Start Team')?.disabled).toBe(false)
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
