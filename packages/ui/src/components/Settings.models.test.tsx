import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { NO_CAPABILITIES, runtimeId, type RuntimeInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
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
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, listCredentials: async () => [] } as unknown as AppStore
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope>
      <Settings route={{ kind: 'section', section: 'models', focus: null }} onRoute={() => {}} onSignIn={() => {}} />
    </SettingsTestScope></StoreProvider>))
    expect(box.querySelector('[data-slot="section-action"] [data-slot="text"]')?.textContent).toBe(summary)
    expect(box.querySelectorAll('[role="switch"][aria-checked="true"]')).toHaveLength(visible)
  } finally { act(() => root.unmount()); box.remove() }
})
