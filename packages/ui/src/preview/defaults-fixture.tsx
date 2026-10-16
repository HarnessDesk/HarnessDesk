import { useState } from 'react'
import type { ConfigOption, HostMethodName, RuntimeId } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { previewStore } from './harness'
import { App } from '../app/App'
import { destinationForSettings } from '../app/settings-destination'

export const defaultsDeclarations = (runtime: string): readonly ConfigOption[] => [
  { id: 'access', label: 'Permissions', category: '_permissions', type: 'select', currentValue: 'workspace', recommendedValue: 'workspace', choices: [
    { value: 'workspace', label: 'Workspace write' }, { value: 'full', label: 'Full access', risk: 'high' },
  ] },
  { id: 'model', label: 'Model', category: 'model', type: 'select', currentValue: `${runtime}-balanced`, recommendedValue: `${runtime}-balanced`, choices: [
    { value: `${runtime}-balanced`, label: 'Balanced' }, { value: `${runtime}-large`, label: 'Large' },
  ] },
  { id: 'effort', label: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'medium', recommendedValue: 'medium', choices: [
    { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
  ] },
]

export const ConversationDefaultsPreview = () => {
  const [store] = useState(() => {
    const store = frameDestinationStore(previewStore())
    const request = store.transport.request.bind(store.transport)
    const refused = new URLSearchParams(location.search).has('defaults-refused')
    let preferences: Record<string, unknown> = {}
    store.transport.request = (async (method: HostMethodName, params: { runtime?: RuntimeId; values?: Record<string, unknown>; patch?: Record<string, unknown> }) => {
      if (method === 'runtime/sessionDefaults') return defaultsDeclarations(params.runtime ?? 'demo').map(option => ({ ...option,
        currentValue: refused && option.id === 'access' ? 'full' : params.values?.[option.id] ?? option.currentValue }))
      if (method === 'app/state/set') { preferences = { ...preferences, ...params.patch }; return {} }
      if (method === 'app/state/get') return preferences
      return request(method, params as never)
    }) as typeof store.transport.request
    store.openDestination(destinationForSettings('general'))
    return store
  })
  return <StoreProvider store={store}><App /></StoreProvider>
}
