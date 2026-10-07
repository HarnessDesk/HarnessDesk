import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type ConfigOption, type RuntimeInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { Settings } from './Settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

for (const reported of [true, false]) it(`describes only saved preferences when model status is ${reported ? 'reported' : 'absent'}`, async () => {
  const runtime = { id: runtimeId('fixture'), presentation: { name: 'Fixture agent' }, capabilities: NO_CAPABILITIES } as RuntimeInfo
  const options: ConfigOption[] = [
    { id: 'model', label: 'Model', type: 'select', currentValue: 'brain-9', choices: [{ value: 'brain-9', label: 'Brain 9' }] },
    { id: 'max-mode', label: 'Max mode', type: 'boolean', currentValue: true, ...(reported ? { modelStatus: 'Auto Max' } : {}) },
  ]
  const snapshot = { ...emptySnapshot(), activeRuntime: runtime.id, runtimes: [runtime], activeSessionKey: 'fixture:s1',
    sessions: new Map([['fixture:s1', { options }]]) }
  const saveCustomPresets = vi.fn(async () => {})
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, listCredentials: async () => [], saveCustomPresets } as unknown as AppStore
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent?.trim() === label)!
  try {
    await act(async () => root.render(<StoreProvider store={store}><Settings section="models" onClose={() => {}} onSection={() => {}} onSignIn={() => {}} /></StoreProvider>))
    await act(async () => button('Save current session').click())
    const dialog = document.body.querySelector('[role="dialog"]:not([data-slot="app-window"])')!
    const description = reported ? 'Brain 9' : 'Brain 9 · Max mode'
    expect(dialog.textContent).toContain(description)
    if (reported) expect.soft(dialog.textContent).not.toContain('Max mode')
    const input = dialog.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Saved preferences')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Save preset').click())
    expect(saveCustomPresets).toHaveBeenCalledWith([expect.objectContaining({ description, values: reported ? { model: 'brain-9' } : { model: 'brain-9', 'max-mode': true } })])
  } finally { act(() => root.unmount()); box.remove() }
})
