import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type RuntimeInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, AppStore } from '../state/store'
import { SettingsTestScope } from '../test-support/settings-page'
import { Settings } from './Settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each([
  { hidden: ['retired-a', 'retired-b', 'retired-c'], summary: 'All in the composer', visible: 2 },
  { hidden: ['retired', 'model-a', 'model-a'], summary: '1 of 2 in the composer', visible: 1 },
])('counts only current models despite stale or duplicate hidden IDs: $summary', async ({ hidden, summary, visible }) => {
  const runtime = { id: runtimeId('demo'), presentation: { name: 'Demo runtime' }, capabilities: NO_CAPABILITIES } as RuntimeInfo
  const snapshot = { ...emptySnapshot(), activeRuntime: runtime.id, runtimes: [runtime],
    models: ['a', 'b'].map(id => ({ id: `model-${id}`, displayName: `Model ${id.toUpperCase()}`, reasoningLevels: [], supportsImages: false })),
    hiddenModels: { [runtime.id]: hidden } }
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), snapshot)
  vi.spyOn(store, 'listCredentials').mockResolvedValue([])
  const request = vi.spyOn(store.transport, 'request').mockResolvedValue({} as never)
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope>
      <Settings route={{ kind: 'section', section: 'models', focus: null }} onRoute={() => {}} onSignIn={() => {}} />
    </SettingsTestScope></StoreProvider>))
    expect(box.querySelector('[data-slot="section-action"] [data-slot="text"]')?.textContent).toBe(summary)
    expect(box.querySelectorAll('[role="switch"][aria-checked="true"]')).toHaveLength(visible)
    const showAll = [...box.querySelectorAll('button')].find(button => button.textContent === 'Show all')
    expect(Boolean(showAll)).toBe(visible < snapshot.models.length)
    if (showAll) {
      await act(async () => {
        const changed = new Promise<void>(resolve => {
          const off = store.subscribe(() => { off(); resolve() })
        })
        showAll.click()
        await changed
      })
      expect(store.getSnapshot().hiddenModels[runtime.id]).toEqual([])
      expect(box.querySelector('[data-slot="section-action"] [data-slot="text"]')?.textContent).toBe('All in the composer')
      expect(box.querySelectorAll('[role="switch"][aria-checked="true"]')).toHaveLength(snapshot.models.length)
      expect([...box.querySelectorAll('button')].some(button => button.textContent === 'Show all')).toBe(false)
      expect(request).toHaveBeenCalledWith('app/state/set', expect.objectContaining({ patch: { hiddenModels: { [runtime.id]: [] } } }))
    }
  } finally { act(() => root.unmount()); box.remove() }
})
