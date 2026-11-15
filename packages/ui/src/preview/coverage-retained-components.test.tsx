import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RetainedComponentsCoverage } from './coverage-retained-components'
import { StoreProvider } from '../state/context'
import { previewStore } from './harness'

vi.mock('./main', () => ({
  Frame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Dial: ({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) =>
    <label>{label}<select value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option}>{option}</option>)}</select></label>,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('mounts the real retained-stop attention component on the recorded coverage board', async () => {
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={previewStore()}><RetainedComponentsCoverage /></StoreProvider>))
    const select = [...box.querySelectorAll('select')].find(one => one.parentElement?.textContent?.includes('saved component state'))!
    await act(async () => { select.value = 'recorded'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(box.textContent).toContain('Stop unconfirmed')
    expect([...box.querySelectorAll('button')].some(one => one.textContent === 'Mark reviewed')).toBe(true)
  } finally { act(() => root.unmount()); box.remove() }
})
